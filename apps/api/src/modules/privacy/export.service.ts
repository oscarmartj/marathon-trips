import { Inject, Injectable } from '@nestjs/common';
import type { ExportAudience } from '../../platform/entities/entity-registry';
import { Prisma } from '../../generated/prisma/client';
import type { AuditActor } from '../../platform/audit/audit.service';
import { AuditService } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { customerRecordIds, platformExport, staffNotesOf } from '../../platform/privacy/records';
import { ConsentService } from './consent.service';


export const EXPORT_FORMAT = 'marathon-trips.personal-data.v1';

const INTERNAL_KEY = /hash|token|secret|ciphertext/i;
const ID_KEY = /^(id|.*Id)$/;

/**
 * Strips what the person should not get and what means nothing outside our systems (plan section 4): any id (a booking
 * id becomes its reference), any hash, token or secret, and rows left empty. Values are made JSON-safe (bigint as text).
 */
export function sanitiseRow(row: unknown, references: ReadonlyMap<string, string>): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (INTERNAL_KEY.test(k)) continue;
    if (k === 'bookingId' && typeof v === 'string') {
      const ref = references.get(v);
      if (ref) out.bookingReference = ref;
      continue;
    }
    if (ID_KEY.test(k)) continue;
    if (v instanceof Uint8Array) continue;
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const inner = sanitiseRow(v, references);
      if (inner) out[k] = inner;
    } else out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface ExportSubject {
  customerId: string | null;
  userId: string | null;
  emails: string[];
}

/**
 * The data export (task 5.5, plan section 6): built on demand from the entity registry and the executor's own tables,
 * never stored. The read runs in one read-only REPEATABLE READ transaction (one consistent picture); the request row and
 * the audit row are written afterwards in their own transaction, without personal data.
 */
@Injectable()
export class ExportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntityRegistry) private readonly registry: EntityRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConsentService) private readonly consent: ConsentService,
  ) {}

  async build(who: ExportSubject, audience: ExportAudience): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const references = new Map<string, string>();
      const sections: Record<string, unknown[]> = {};
      let staffNotes: unknown[] | undefined;
      if (who.customerId) {
        for (const b of await tx.booking.findMany({ where: { customerId: who.customerId }, select: { id: true, reference: true } })) references.set(b.id, b.reference);
        for (const def of this.registry.withCustomerLink()) {
          const rows = (await def.handlers!.export(tx, who.customerId, { audience, emails: who.emails }))
            .map((r) => sanitiseRow(r, references))
            .filter((r): r is Record<string, unknown> => r !== null);
          if (rows.length > 0) sections[def.entityType] = rows;
        }
        if (audience === 'full') {
          staffNotes = (await staffNotesOf(tx, await customerRecordIds(tx, this.registry, who.customerId))).map((n) => {
            const { entityId, ...rest } = n as Record<string, unknown> & { entityId: string };
            return { ...rest, ...(references.has(entityId) ? { bookingReference: references.get(entityId) } : {}) };
          });
        }
      } else {
        // An account with no customer record: what is linked to its address only (alerts).
        for (const def of this.registry.withCustomerLink().filter((d) => d.entityType === 'AlertSubscription')) {
          const rows = (await def.handlers!.export(tx, '00000000-0000-0000-0000-000000000000', { audience, emails: who.emails })).map((r) => sanitiseRow(r, references)).filter((r) => r !== null);
          if (rows.length > 0) sections[def.entityType] = rows;
        }
      }
      const platform = await platformExport(tx, who);
      const consents = await tx.consentRecord.findMany({
        where: { purpose: 'marketing_email', OR: [...(who.customerId ? [{ customerId: who.customerId }] : []), ...who.emails.map((e) => ({ emailHash: this.consent.hashOf(e) }))] },
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
        select: { granted: true, source: true, recordedAt: true },
      });
      return {
        format: EXPORT_FORMAT,
        generatedAt: new Date().toISOString(),
        audience,
        account: platform.account,
        sections,
        marketingConsent: consents,
        emails: platform.emails,
        signIns: platform.signIns,
        ...(staffNotes ? { staffNotes } : {}),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** The proof that an export was made, in its own transaction after the read: no personal data in either row. */
  async record(who: ExportSubject, requestedBy: 'customer' | 'staff', actor: AuditActor & { id: string }, audience: ExportAudience): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.privacyRequest.create({
        data: { customerId: who.customerId, userId: who.customerId ? null : who.userId, kind: 'export', status: 'completed', requestedBy, completedAt: now, actorUserId: actor.id },
      });
      await this.audit.record(tx, {
        actor, action: 'privacy.export.generated', entityType: who.customerId ? 'Customer' : 'User', entityId: (who.customerId ?? who.userId)!,
        context: { audience, requestedBy },
      });
    });
  }
}
