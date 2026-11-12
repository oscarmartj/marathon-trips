import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { PrismaService } from '../../platform/database/prisma.service';
import { ConsumerRegistry } from '../../platform/events/consumers';
import { SettingsService } from '../../platform/flags/flags.service';
import { MailTemplateRegistry } from '../../platform/mail/templates';
import { BookingsModule } from '../bookings';
import { CatalogueModule } from '../catalogue';
import { PricingModule } from '../pricing';
import { QuoteAcceptanceService } from './acceptance.service';
import { CustomerQuotesController, QuotesAdminController } from './controllers';
import { BOOKING_MAIL_STATES, CrmEmails, QUOTE_SENT_TEMPLATE, bookingTemplate } from './emails';
import { QuoteExpiryService } from './expiry.service';
import { crmManifest } from './manifest';
import { setQuoteOwnershipDb } from './ownership';
import { QuoteService } from './quote.service';
import { defineCrmSettings } from './settings';

@Module({
  imports: [BookingsModule, CatalogueModule, PricingModule],
  controllers: [QuotesAdminController, CustomerQuotesController],
  providers: [QuoteService, QuoteAcceptanceService, QuoteExpiryService, CrmEmails],
})
export class CrmModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(ConsumerRegistry) private readonly consumers: ConsumerRegistry,
    @Inject(MailTemplateRegistry) private readonly templates: MailTemplateRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CrmEmails) private readonly emails: CrmEmails,
  ) {}

  /** Permissions, the setting, the templates, the consumer and the ownership check, before serving. */
  onModuleInit(): void {
    this.permissions.register(crmManifest.permissions);
    defineCrmSettings(this.settings);
    setQuoteOwnershipDb(this.prisma);
    this.templates.register({ ...QUOTE_SENT_TEMPLATE, render: (ctx) => this.emails.renderQuote(ctx) });
    for (const state of BOOKING_MAIL_STATES) this.templates.register({ ...bookingTemplate(state), render: (ctx) => this.emails.renderBooking(state, ctx) });
    // bookings has no feature flag, so a held event can only mean the API was stopped; notices older than 48 h are dropped.
    this.consumers.register({
      name: 'crm.booking_emails', module: 'bookings', events: ['bookings.booking.*'], whenDisabled: 'hold', notifyOnly: true,
      handle: (event, ctx) => this.emails.onBookingEvent(event, ctx),
    });
  }
}
