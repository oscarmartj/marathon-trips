import { Inject, Injectable } from '@nestjs/common';
import { AUTOMATION_EMAIL_TEMPLATES, automationTemplateKey, isCustomerTemplate } from '@mt/shared';
import type { AutomationEmailTemplate } from '@mt/shared';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { AppError } from '../../platform/errors/safe-error';
import { MAIL_NOT_SENDABLE } from '../../platform/mail/mail.service';
import type { MailTemplate, RenderContext, RenderedMail } from '../../platform/mail/templates';
import { TemplatesService } from '../templates';
import { loadEntity } from './facts';

const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};

const ADMIN_PATH = { Booking: 'bookings', Quote: 'quotes', Package: 'packages' } as const;

/**
 * The emails an automation sends (task 7.4). The wording is only ever a template staff put into use in the templates
 * panel (task 5.4); there is no built-in text, so with no template in use nothing is sent. Values are read from ids at
 * send time. Customer notices carry no amount; the staff notice carries no customer name or address.
 */
@Injectable()
export class AutomationEmails {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
  ) {}

  mailTemplates(): MailTemplate[] {
    // Customer notices are checked for an `all` suppression again at send time (task 7.fix-2): a bounce or complaint after
    // queueing stops a retry. Those queued as marketing (no service acknowledgement) are checked for any suppression.
    return AUTOMATION_EMAIL_TEMPLATES.map((t) => ({
      key: automationTemplateKey(t), version: 1, render: (ctx: RenderContext) => this.render(t, ctx), ...(isCustomerTemplate(t) ? { suppressedBy: 'all' as const } : {}),
    }));
  }

  private url(path: string): string {
    return `${new URL(this.config.WEB_ORIGIN).origin}${path}`;
  }

  private async render(template: AutomationEmailTemplate, ctx: RenderContext): Promise<RenderedMail> {
    const values = isCustomerTemplate(template) ? await this.customerValues(ctx) : await this.staffValues(ctx);
    const out = await this.templates.renderEmail(ctx.tx, automationTemplateKey(template), ctx.email.locale, values);
    if (!out) throw new AppError(MAIL_NOT_SENDABLE, 'The template for this email is not in use');
    return { subject: out.subject, text: out.text };
  }

  private async customerValues(ctx: RenderContext): Promise<Record<string, string>> {
    const type = ctx.email.relatedEntityType;
    const id = ctx.email.relatedEntityId;
    if ((type !== 'Booking' && type !== 'Quote') || !id) throw new AppError(MAIL_NOT_SENDABLE, 'The email is not linked to a booking or quote');
    const entity = await loadEntity(ctx.tx, type, id);
    const rec = entity?.entityType === 'Booking' ? entity.booking : entity?.entityType === 'Quote' ? entity.quote : null;
    if (!rec || rec.customer.unavailable) throw new AppError(MAIL_NOT_SENDABLE, 'The record or its customer is no longer available');
    const trip = `${en(rec.trip.raceName)} ${rec.trip.year}: ${en(rec.trip.packageName)}`;
    const link = this.url(type === 'Booking' ? `/trips/requests/${rec.reference}` : `/quotes/${rec.reference}`);
    return { givenName: rec.customer.givenName, reference: rec.reference, trip, link };
  }

  private async staffValues(ctx: RenderContext): Promise<Record<string, string>> {
    const runId = ctx.email.relatedEntityType === 'AutomationRun' ? ctx.email.relatedEntityId : null;
    const run = runId ? await ctx.tx.automationRun.findUnique({ where: { id: runId }, select: { entityType: true, entityId: true, rule: { select: { id: true, name: true } } } }) : null;
    if (!run) throw new AppError(MAIL_NOT_SENDABLE, 'The automation run is gone');
    let reference = '';
    let adminLink = this.url(`/admin/automations/${run.rule.id}`);
    if ((run.entityType === 'Booking' || run.entityType === 'Quote' || run.entityType === 'Package') && run.entityId) {
      const entity = await loadEntity(ctx.tx, run.entityType, run.entityId);
      if (entity?.entityType === 'Booking') reference = entity.booking.reference;
      if (entity?.entityType === 'Quote') reference = entity.quote.reference;
      adminLink = this.url(`/admin/${ADMIN_PATH[run.entityType]}/${run.entityId}`);
    }
    return { ruleName: run.rule.name, reference, adminLink };
  }
}
