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
    // Subscriptions are not customer data until a customer account is linked (5.1); the handlers are ready for 5.5.
    this.entities.register({
      entityType: 'AlertSubscription', model: 'AlertSubscription', customerLink: { kind: 'column', column: 'customerId' },
      handlers: {
        export: (tx, customerId) => tx.alertSubscription.findMany({ where: { customerId }, select: { email: true, raceId: true, editionId: true, status: true, createdAt: true, confirmedAt: true } }),
        anonymise: async (tx, customerId) => void (await tx.alertSubscription.deleteMany({ where: { customerId } })),
      },
    });
  }
}
