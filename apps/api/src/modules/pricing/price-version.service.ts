import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { createPriceVersionSchema, publishPriceVersionSchema, setRatesSchema } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { PackagePricingReader, lockPackage } from '../catalogue';
import type { ChangeTarget, PackagePricingView } from '../catalogue';
import { missingRates } from './engine';
import { engineView, loadRates, toJson, versionInForce } from './rates';

type Actor = AuditActor & { id: string };
type Tx = Prisma.TransactionClient;
type VersionRow = { id: string; packageId: string; currency: string; status: string; version: number };

const versionConflict = () => conflict('version_conflict', 'Someone else changed this. Reload and try again.');

/** True when a database error is an EXCLUDE (overlapping published versions, 23P01). */
function isExclusionViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) && !(err instanceof Prisma.PrismaClientUnknownRequestError)) return false;
  return /23P01|exclusion constraint|price_versions_no_overlap/.test(`${JSON.stringify((err as { meta?: unknown }).meta ?? {})} ${err.message}`);
}

/** Price versions and their rates (plan 2.1, sections 1 and 12). Published rates are frozen by the database. */
@Injectable()
export class PriceVersionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
  ) {}

  private async packageOrNotFound(tx: Tx, packageId: string): Promise<PackagePricingView> {
    const view = await this.catalogue.load(tx, packageId);
    if (!view) throw notFound('package_not_found', 'Package not found');
    return view;
  }

  /** The version row, locked FOR UPDATE, or 404. */
  private async lockVersion(tx: Tx, id: string): Promise<VersionRow> {
    const rows = await tx.$queryRaw<VersionRow[]>`SELECT id, "packageId", currency, status::text AS status, version FROM price_versions WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows[0]) throw notFound('price_version_not_found', 'Price version not found');
    return rows[0];
  }

  async list(packageId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.packageOrNotFound(tx, packageId);
      const rows = await tx.priceVersion.findMany({ where: { packageId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const current = await versionInForce(tx, packageId, new Date());
      return { currentId: current?.id ?? null, items: toJson(rows) };
    });
  }

  /** A version with its rates and, against the catalogue as it is now, what it lacks to be published. */
  async get(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.priceVersion.findUnique({ where: { id } });
      if (!v) throw notFound('price_version_not_found', 'Price version not found');
      const view = await this.packageOrNotFound(tx, v.packageId);
      const rates = await loadRates(tx, v.id, v.currency);
      return toJson({ ...v, rates: { roomRates: rates.roomRates, participationRates: rates.participationRates, extraRates: rates.extraRates }, missing: missingRates(engineView(view), rates) });
    });
  }

  async create(actor: Actor, packageId: string, input: z.infer<typeof createPriceVersionSchema>) {
    const id = await this.prisma.$transaction(async (tx) => {
      const view = await this.packageOrNotFound(tx, packageId);
      const created = await tx.priceVersion.create({ data: { packageId, currency: view.currency, label: input.label, status: 'draft' } });
      let copied: Pick<Awaited<ReturnType<typeof loadRates>>, 'roomRates' | 'participationRates' | 'extraRates'> = { roomRates: [], participationRates: [], extraRates: [] };
      if (input.copyCurrent) {
        const current = await versionInForce(tx, packageId, new Date());
        if (current) {
          // Only what the package still has: deleted extras and removed rooms or distances are not copied.
          const rates = await loadRates(tx, current.id, current.currency);
          const rooms = new Set(view.rooms.map((r) => r.id));
          const extras = new Set(view.extras.map((e) => e.id));
          const distances = new Set(view.raceDistanceIds);
          copied = {
            roomRates: rates.roomRates.filter((r) => rooms.has(r.roomOptionId)),
            participationRates: rates.participationRates.filter((r) => r.raceDistanceId === null || distances.has(r.raceDistanceId)),
            extraRates: rates.extraRates.filter((r) => extras.has(r.extraId)),
          };
          await this.writeRates(tx, created.id, created.currency, copied);
        }
      }
      await this.audit.record(tx, {
        actor, action: 'pricing.price_version.created', entityType: 'PriceVersion', entityId: created.id, reason: input.reason,
        after: { ...(toJson(created) as Record<string, unknown>), ...(toJson(copied) as Record<string, unknown>) },
        fieldClasses: { roomRates: 'nopii', participationRates: 'nopii', extraRates: 'nopii' },
      });
      return created.id;
    });
    return this.get(id);
  }

  private async writeRates(tx: Tx, priceVersionId: string, currency: string, r: Pick<Awaited<ReturnType<typeof loadRates>>, 'roomRates' | 'participationRates' | 'extraRates'>): Promise<void> {
    if (r.roomRates.length) await tx.roomRate.createMany({ data: r.roomRates.map((x) => ({ priceVersionId, currency, roomOptionId: x.roomOptionId, occupancy: x.occupancy, pricePerPersonMinor: x.pricePerPersonMinor, extraNightPerPersonMinor: x.extraNightPerPersonMinor })) });
    if (r.participationRates.length) await tx.participationRate.createMany({ data: r.participationRates.map((x) => ({ priceVersionId, currency, participationType: x.participationType, raceDistanceId: x.raceDistanceId, amountPerPersonMinor: x.amountPerPersonMinor })) });
    if (r.extraRates.length) await tx.extraRate.createMany({ data: r.extraRates.map((x) => ({ priceVersionId, currency, extraId: x.extraId, amountMinor: x.amountMinor })) });
  }

  /**
   * Replaces every rate of a draft (compare-and-set on its version, M2). Each rate must price something of the package:
   * one of its rooms (any occupancy 1–4, so a room can be priced before it takes more people), a distance of its race,
   * or one of its extras.
   */
  async setRates(actor: Actor, id: string, input: z.infer<typeof setRatesSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const v = await this.lockVersion(tx, id);
      if (v.status !== 'draft') throw conflict('price_version_not_draft', 'Only a draft price version can be edited');
      if (v.version !== input.version) throw versionConflict();
      const view = await this.packageOrNotFound(tx, v.packageId);
      const rooms = new Set(view.rooms.map((r) => r.id));
      const extras = new Set(view.extras.map((e) => e.id));
      const distances = new Set(view.raceDistanceIds);
      const seen = new Set<string>();
      const once = (key: string) => {
        if (seen.has(key)) throw unprocessable('rate_duplicated', 'The same rate is listed twice');
        seen.add(key);
      };
      for (const r of input.roomRates) {
        if (!rooms.has(r.roomOptionId)) throw unprocessable('rate_target_not_in_package', 'A rate prices a room of another package');
        once(`room:${r.roomOptionId}:${r.occupancy}`);
      }
      for (const r of input.participationRates) {
        if ((r.participationType === 'runner_with_entry') !== (r.raceDistanceId !== null)) throw unprocessable('distance_required_iff_runner_with_entry', 'Only a runner with an entry has a distance, and always has one');
        if (r.raceDistanceId !== null && !distances.has(r.raceDistanceId)) throw unprocessable('rate_target_not_in_package', 'A rate prices a distance of another race');
        once(`participation:${r.participationType}:${r.raceDistanceId}`);
      }
      for (const r of input.extraRates) {
        if (!extras.has(r.extraId)) throw unprocessable('rate_target_not_in_package', 'A rate prices an extra of another package');
        once(`extra:${r.extraId}`);
      }
      const before = await loadRates(tx, id, v.currency);
      await tx.roomRate.deleteMany({ where: { priceVersionId: id } });
      await tx.participationRate.deleteMany({ where: { priceVersionId: id } });
      await tx.extraRate.deleteMany({ where: { priceVersionId: id } });
      const after = {
        roomRates: input.roomRates.map((r) => ({ roomOptionId: r.roomOptionId, occupancy: r.occupancy, pricePerPersonMinor: BigInt(r.pricePerPersonMinor), extraNightPerPersonMinor: BigInt(r.extraNightPerPersonMinor), currency: v.currency })),
        participationRates: input.participationRates.map((r) => ({ participationType: r.participationType, raceDistanceId: r.raceDistanceId, amountPerPersonMinor: BigInt(r.amountPerPersonMinor), currency: v.currency })),
        extraRates: input.extraRates.map((r) => ({ extraId: r.extraId, amountMinor: BigInt(r.amountMinor), currency: v.currency })),
      };
      await this.writeRates(tx, id, v.currency, after);
      const res = await tx.priceVersion.updateMany({ where: { id, version: input.version, status: 'draft' }, data: { version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const strip = (x: typeof after) => toJson({ roomRates: x.roomRates, participationRates: x.participationRates, extraRates: x.extraRates }) as Record<string, unknown>;
      await this.audit.record(tx, {
        actor, action: 'pricing.price_version.rates_set', entityType: 'PriceVersion', entityId: id, reason: input.reason,
        before: strip(before), after: strip(after), fieldClasses: { roomRates: 'nopii', participationRates: 'nopii', extraRates: 'nopii' },
      });
    });
    return this.get(id);
  }

  /**
   * Publishes a draft now (plan 2.1, section 12): the package is locked FOR UPDATE (M3), the version in force must be
   * the one the publisher saw, the draft must be complete against the catalogue (G1), the version in force gets its
   * end and the draft starts at the same instant, then the
   * audit entry and the pricing.price_version.published event, all in one transaction.
   */
  async publish(actor: Actor, id: string, input: z.infer<typeof publishPriceVersionSchema>) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const peek = await tx.priceVersion.findUnique({ where: { id }, select: { packageId: true } });
        if (!peek) throw notFound('price_version_not_found', 'Price version not found');
        await lockPackage(tx, peek.packageId, 'update');
        const v = await this.lockVersion(tx, id);
        if (v.status !== 'draft') throw conflict('price_version_not_draft', 'Only a draft price version can be published');
        if (v.version !== input.version) throw versionConflict();
        const view = await this.packageOrNotFound(tx, v.packageId);
        if (view.currency !== v.currency) throw conflict('currency_mismatch', 'The price version is in another currency');
        const missing = missingRates(engineView(view), await loadRates(tx, id, v.currency));
        if (missing.length > 0) throw conflict('price_version_incomplete', 'This version lacks rates for some rooms, travellers or extras');
        // One instant for both ends, read from the database clock after the locks (not now(), which is the start of the
        // transaction and may be before a lock wait) and cut to the millisecond the columns keep (code review, M2 of round 1).
        const at = (await tx.$queryRaw<Array<{ at: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`)[0]!.at;
        // Compare-and-set on the version in force: of two drafts published at once, only one wins (M3).
        const inForce = await versionInForce(tx, v.packageId, at);
        if ((inForce?.id ?? null) !== input.replacesVersionId) throw conflict('current_version_changed', 'The prices in force changed since you looked. Reload and try again.');
        if (inForce) {
          await tx.$executeRaw`UPDATE price_versions SET "validTo" = ${at}, "updatedAt" = ${at} WHERE id = ${inForce.id}::uuid AND status = 'published' AND "validTo" IS NULL`;
          await this.audit.record(tx, {
            actor, action: 'pricing.price_version.closed', entityType: 'PriceVersion', entityId: inForce.id, reason: input.reason,
            before: { validTo: null }, after: { validTo: at }, context: { successorVersionId: id },
          });
        }
        const published = await tx.$executeRaw`
          UPDATE price_versions SET status = 'published', "validFrom" = ${at}, "publishedAt" = ${at}, "publishedById" = ${actor.id}::uuid,
            version = version + 1, "updatedAt" = ${at}
          WHERE id = ${id}::uuid AND status = 'draft' AND version = ${input.version}`;
        if (published !== 1) throw versionConflict();
        const previous = inForce ? [{ id: inForce.id }] : [];
        await this.audit.record(tx, {
          actor, action: 'pricing.price_version.published', entityType: 'PriceVersion', entityId: id, reason: input.reason,
          before: { status: 'draft', validFrom: null }, after: { status: 'published', validFrom: at }, context: { previousVersionId: previous[0]?.id ?? null },
        });
        await this.outbox.publish(tx, {
          type: 'pricing.price_version.published', aggregateType: 'PriceVersion', aggregateId: id, aggregateVersion: input.version + 1,
          payload: { priceVersionId: id, packageId: v.packageId, previousVersionId: previous[0]?.id ?? null },
          actorType: actor.type, actorId: actor.id,
        });
      });
    } catch (err) {
      if (isExclusionViolation(err)) throw conflict('price_version_overlap', 'Another version was published at the same time. Reload and try again.');
      throw err;
    }
    return this.get(id);
  }

  /**
   * Discards a draft by archiving it (plan 2.1, M1): the row stays, its rates are removed and kept in the audit entry.
   * An archived version is never priced, published or changed again.
   */
  async discard(actor: Actor, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const v = await this.lockVersion(tx, id);
      if (v.status !== 'draft') throw conflict('price_version_not_draft', 'Only a draft price version can be discarded');
      // Its rates go (they were never in force; the audit keeps them) so they never pin a room or a distance.
      const rates = await loadRates(tx, id, v.currency);
      await tx.roomRate.deleteMany({ where: { priceVersionId: id } });
      await tx.participationRate.deleteMany({ where: { priceVersionId: id } });
      await tx.extraRate.deleteMany({ where: { priceVersionId: id } });
      const res = await tx.priceVersion.updateMany({ where: { id, status: 'draft' }, data: { status: 'archived' } });
      if (res.count !== 1) throw versionConflict();
      await this.audit.record(tx, {
        actor, action: 'pricing.price_version.discarded', entityType: 'PriceVersion', entityId: id,
        before: { status: 'draft', ...(toJson({ roomRates: rates.roomRates, participationRates: rates.participationRates, extraRates: rates.extraRates }) as Record<string, unknown>) },
        after: { status: 'archived', roomRates: [], participationRates: [], extraRates: [] },
        fieldClasses: { roomRates: 'nopii', participationRates: 'nopii', extraRates: 'nopii' },
      });
    });
  }

  // ---- Checks the catalogue runs (registered in PricingModule) ----

  /** Open gate: a published version in force now, complete against the catalogue as it is in `tx`. */
  async openGate(tx: Tx, packageId: string): Promise<{ code: string; message: string } | null> {
    const current = await versionInForce(tx, packageId, new Date());
    if (!current) return { code: 'no_current_price_version', message: 'Publish a price version first' };
    const view = await this.catalogue.load(tx, packageId);
    if (!view) return null;
    const missing = missingRates(engineView(view), await loadRates(tx, current.id, current.currency));
    if (missing.length > 0) return { code: 'price_version_incomplete', message: 'The prices in force lack rates for some rooms, travellers or extras. Publish a version that prices them first.' };
    return null;
  }

  async changeGate(tx: Tx, target: ChangeTarget): Promise<{ code: string; message: string } | null> {
    if (target.kind === 'room') {
      return (await tx.roomRate.count({ where: { roomOptionId: target.roomOptionId } })) > 0 ? { code: 'room_has_rates', message: 'This room has prices and cannot be removed' } : null;
    }
    if (target.kind === 'distance') {
      return (await tx.participationRate.count({ where: { raceDistanceId: target.raceDistanceId } })) > 0 ? { code: 'distance_has_rates', message: 'This distance has prices and cannot be removed' } : null;
    }
    if (target.kind === 'extra_terms') {
      // A published rate means "this much per person" or "this much per booking": changing the unit would change what
      // every later quote charges under the same price version, without a publish or its step-up (code review, round 1).
      const published = await tx.extraRate.count({ where: { extraId: target.extraId, priceVersion: { status: 'published', OR: [{ validTo: null }, { validTo: { gt: new Date() } }] } } });
      if (published === 0) return null;
      if (target.pricingUnitChanged) return { code: 'extra_has_rates', message: 'This extra has published prices; its pricing unit cannot change. Add a new extra instead.' };
      if (target.termsChanged && target.onSale) return { code: 'extra_has_rates', message: 'Take the package off sale before changing who must or may take a priced extra.' };
      return null;
    }
    const inDraft = await tx.participationRate.count({ where: { raceDistanceId: target.raceDistanceId, priceVersion: { packageId: target.packageId, status: 'draft' } } });
    return inDraft > 0 ? { code: 'entry_option_has_rates', message: 'A draft price version prices this distance. Remove that rate first.' } : null;
  }
}
