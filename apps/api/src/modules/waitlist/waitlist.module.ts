import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { MailTemplateRegistry } from '../../platform/mail/templates';
import { SettingsService } from '../../platform/flags/flags.service';
import { SYSTEM_ACTOR } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { setWaitlistOwnershipDb } from './ownership';
import { OFFER_TEMPLATE, WAITLIST_SETTINGS } from './tokens';
import { PermissionRegistry } from '../../platform/access/permissions';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { WaitlistAdminController } from './waitlist.controller';
import { waitlistManifest } from './manifest';
import { WaitlistService } from './waitlist.service';

@Module({
  controllers: [WaitlistAdminController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(MailTemplateRegistry) private readonly templates: MailTemplateRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WaitlistService) private readonly waitlist: WaitlistService,
  ) {}

  /** Permissions and the customer link of the waiting list table, before serving. */
  onModuleInit(): void {
    this.permissions.register(waitlistManifest.permissions);
    this.settings.define(WAITLIST_SETTINGS.offerHours.key, WAITLIST_SETTINGS.offerHours.schema, 1, { description: WAITLIST_SETTINGS.offerHours.description });
    this.templates.register({ ...OFFER_TEMPLATE, render: (ctx) => this.waitlist.renderOffer(ctx) });
    setWaitlistOwnershipDb(this.prisma);
    this.entities.register({
      entityType: 'WaitlistEntry', model: 'WaitlistEntry', customerLink: { kind: 'column', column: 'customerId' },
      handlers: {
        export: (tx, customerId) => tx.waitlistEntry.findMany({ where: { customerId }, select: { email: true, packageId: true, reason: true, status: true, countryOfResidence: true, travellers: true, createdAt: true } }),
        // Erasing a customer takes them off the list: nobody gets an offer for an erased person. The API role cannot
        // delete (only mt_privacy can), so the entry is withdrawn and redacted here; task 5.5's purge may delete it.
        anonymise: async (tx, customerId) => {
          // An offer holds places: bookings gives them back (and offers them on) before the entry is withdrawn.
          for (const e of await tx.waitlistEntry.findMany({ where: { customerId, status: 'offered' }, select: { id: true } })) await this.waitlist.closeHeldOffer(tx, e.id, SYSTEM_ACTOR);
          await tx.waitlistEntry.updateMany({ where: { customerId, status: { in: ['waiting', 'offered'] } }, data: { status: 'withdrawn', withdrawnAt: new Date() } });
          await tx.waitlistEntry.updateMany({ where: { customerId }, data: { email: `erased+${customerId}@invalid`, countryOfResidence: 'ZZ', requestContactHmac: null } });
        },
      },
    });
  }
}
