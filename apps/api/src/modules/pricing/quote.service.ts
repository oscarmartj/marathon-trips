import { Inject, Injectable } from '@nestjs/common';
import type { AdminQuoteRequest, QuoteRequest } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../platform/database/prisma.service';
import { ApiError, conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { PackagePricingReader } from '../catalogue';
import { INTERNAL_CODES, NOT_READY_CODES, PricingError, price } from './engine';
import type { PriceBreakdown, PromoInput } from './engine';
import { engineView, loadRates, toJson, versionInForce } from './rates';

/**
 * Until task 2.2 stores promo codes, every code is unknown: the same answer as a disabled, expired or exhausted one
 * (plan 2.1, section 1, point 8), so the route reveals nothing about which codes exist.
 */
const UNKNOWN_CODE: PromoInput = {
  id: 'unknown', usable: false, scopeType: 'global', scopeId: null, conditions: {}, stackable: false,
  effectMode: 'percent', valueBps: 0, valueMinor: null, currency: null, per: 'booking', appliesTo: 'subtotal',
};

/**
 * The HTTP answer for an engine failure: prices not ready → 409, a wrong configuration → 422, a broken invariant of
 * the engine itself → null, so the error stays unexpected (500, logged) and is never blamed on the caller.
 */
export const pricingErrorToHttp = (e: PricingError): ApiError | null =>
  INTERNAL_CODES.has(e.code) ? null : NOT_READY_CODES.has(e.code) ? conflict(e.code, e.message) : unprocessable(e.code, e.message);

/**
 * Quotes (plan 2.1, section 4). Reads the package and its rates in one REPEATABLE READ transaction, takes `now` from
 * the server clock (never from the request) and asks the pure engine. The answer is the only total anyone shows.
 */
@Injectable()
export class QuoteService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
  ) {}

  /** For use inside another module's transaction (2.4): the same engine, the same reads. */
  async priceIn(tx: Prisma.TransactionClient, req: QuoteRequest | AdminQuoteRequest, opts: { audience: 'public' | 'staff'; now: Date }): Promise<PriceBreakdown> {
    const view = await this.catalogue.load(tx, req.packageId);
    if (!view) throw notFound('package_not_found', 'Package not found');
    if (opts.audience === 'public') {
      if (!view.publiclyVisible || view.saleStatus !== 'open') throw notFound('package_not_found', 'Package not found');
      if (!view.deposit) throw conflict('deposit_not_configured', 'This package is not ready for sale');
    }
    const versionId = opts.audience === 'staff' && 'priceVersionId' in req ? req.priceVersionId : undefined;
    let version;
    if (versionId) {
      version = await tx.priceVersion.findFirst({ where: { id: versionId, packageId: req.packageId, status: { not: 'archived' } } });
      if (!version) throw notFound('price_version_not_found', 'Price version not found');
    } else {
      version = await versionInForce(tx, req.packageId, opts.now);
      if (!version) throw conflict('no_current_price_version', 'This package has no prices yet');
    }
    const rates = await loadRates(tx, version.id, version.currency);
    try {
      return price(
        { rooms: req.rooms, extraNightsBefore: req.extraNightsBefore, extraNightsAfter: req.extraNightsAfter, extras: req.extras },
        engineView(view), rates, [], req.promoCode ? UNKNOWN_CODE : null, opts.now,
      );
    } catch (e) {
      if (e instanceof PricingError) throw pricingErrorToHttp(e) ?? e;
      throw e;
    }
  }

  private run(req: QuoteRequest | AdminQuoteRequest, audience: 'public' | 'staff'): Promise<PriceBreakdown> {
    const now = new Date();
    return this.prisma.$transaction((tx) => this.priceIn(tx, req, { audience, now }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** The public answer: the breakdown without the rule trace. */
  async quotePublic(req: QuoteRequest) {
    const { trace: _trace, ...b } = await this.run(req, 'public');
    return toJson(b);
  }

  /** The panel's answer: any package that is not deleted, a draft version if asked, and why each rule did or did not apply. */
  async quoteStaff(req: AdminQuoteRequest) {
    return toJson(await this.run(req, 'staff'));
  }
}
