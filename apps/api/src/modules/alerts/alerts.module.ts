import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { ConsumerRegistry } from '../../platform/events/consumers';
import { MailTemplateRegistry } from '../../platform/mail/templates';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { alertsManifest } from './manifest';
import { CONFIRM_TEMPLATE, OPEN_TEMPLATE } from './tokens';
import { PrismaService } from '../../platform/database/prisma.service';

@Module({
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(ConsumerRegistry) private readonly consumers: ConsumerRegistry,
    @Inject(MailTemplateRegistry) private readonly templates: MailTemplateRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(alertsManifest.permissions);
    this.templates.register({ ...CONFIRM_TEMPLATE, render: (ctx) => this.alerts.renderConfirm(ctx) });
    this.templates.register({ ...OPEN_TEMPLATE, render: (ctx) => this.alerts.renderOpen(ctx) });
    this.consumers.register({
      name: 'alerts.notify_open', module: 'alerts', events: ['catalogue.package.sale_status_changed'], whenDisabled: 'skip', notifyOnly: true,
      handle: async (event, { tx }) => void (await this.alerts.notifyOpen(event, tx)),
    });
    // Subscriptions made through the public form carry only an address (task 5.5, review point 1): a customer's are
    // theirs by customer id or by any of their addresses, compared case-insensitively. Erasure deletes them.
    this.entities.register({
      entityType: 'AlertSubscription', model: 'AlertSubscription', customerLink: { kind: 'column', column: 'customerId' },
      handlers: {
        export: (tx, customerId, opts) => tx.$queryRaw`
          SELECT s.email::text AS email, r.slug AS race, e.year AS "editionYear", s.status::text AS status, s."createdAt", s."confirmedAt", s."unsubscribedAt"
            FROM alert_subscriptions s JOIN races r ON r.id = s."raceId" LEFT JOIN race_editions e ON e.id = s."editionId"
           WHERE s."customerId" = ${customerId}::uuid OR lower(s.email::text) = ANY(${[...(opts?.emails ?? [])]}::text[])
           ORDER BY s."createdAt"`,
        anonymise: async (tx, customerId, ctx) => void (await tx.$executeRaw`
          DELETE FROM alert_subscriptions WHERE "customerId" = ${customerId}::uuid OR lower(email::text) = ANY(${[...(ctx?.emails ?? [])]}::text[])`),
      },
    });
  }
}
