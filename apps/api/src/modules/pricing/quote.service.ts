import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminQuoteRequest, QuoteRequest } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../platform/database/prisma.service';
import { ApiError, conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { PackagePricingReader } from '../catalogue';
import { UNKNOWN_CODE, findPromo, promoInputOf, rulesForPackage } from './adjustments';
import { INTERNAL_CODES, NOT_READY_CODES, PricingError, price } from './engine';
import type { PriceBreakdown, PromoInput, PromoStatus, RuleInput } from './engine';
import { engineView, loadRates, toJson, versionInForce } from './rates';

/**
 * The one promo status an anonymous caller sees (plan 2.2, section 9): a code that is not applied, for whatever reason
 * (unknown, disabled, expired, exhausted, another package, conditions not met, not combinable), reads `invalid`, so the
 * public route never reveals that a code exists. The panel sees the real status. Task 2.4 uses it on its public route.
 */
export function publicPromoStatus(status: PromoStatus): PromoStatus {
  return status === 'none' || status === 'applied' ? status : 'invalid';
}

/**
 * The HTTP answer for an engine failure (plan 2.2, section 15, points 1 and 10). A broken invariant of the engine and a
 * stored rule that the engine refuses are not the caller's fault: null, so the error stays unexpected (500, logged).
 * A rule or code line above the limit is a 409. A code's own configuration error is a 409 in the panel (the public
 * route never gets here: it reads `invalid`). Prices not ready → 409; a wrong configuration → 422.
 */
export const pricingErrorToHttp = (e: PricingError): ApiError | null => {
  if (INTERNAL_CODES.has(e.code)) return null;
  if (e.code === 'adjustment_above_limit') return conflict('adjustment_above_limit', 'A price rule gives an amount above the allowed limit for this booking');
  if (e.details.origin === 'rule' || e.code === 'rule_cap_exceeded') return null;
  if (e.details.origin === 'promo') return conflict('promo_code_misconfigured', 'This promo code is not set up correctly');
  return NOT_READY_CODES.has(e.code) ? conflict(e.code, e.message) : unprocessable(e.code, e.message);
};

export interface PromoRef {
  id: string;
  version: number;
}

/**
 * Quotes (plan 2.1, section 4; plan 2.2, section 7). Reads the package, its rates, the rules of its scopes and the code
 * in one transaction, takes `now` from the server clock (never from the request) and asks the pure engine. The answer
 * is the only total anyone shows.
 */
@Injectable()
export class QuoteService {
  private readonly logger = new Logger('Pricing');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
  ) {}

  /** For use inside another module's transaction (2.4): the same engine, the same reads. */
  async priceIn(tx: Prisma.TransactionClient, req: QuoteRequest | AdminQuoteRequest, opts: { audience: 'public' | 'staff'; now: Date }): Promise<PriceBreakdown> {
    return (await this.priceWithPromoRef(tx, req, opts)).breakdown;
  }

  /**
   * The breakdown and, when a code was applied, the code's id and version as read here: task 2.4 hands them to
   * PromoRedemptionService.redeemIn, which refuses a code that changed since (plan 2.2, section 15, point 3).
   */
  async priceWithPromoRef(tx: Prisma.TransactionClient, req: QuoteRequest | AdminQuoteRequest, opts: { audience: 'public' | 'staff'; now: Date }): Promise<{ breakdown: PriceBreakdown; promoRef: PromoRef | null }> {
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
    const request = { rooms: req.rooms, extraNightsBefore: req.extraNightsBefore, extraNightsAfter: req.extraNightsAfter, extras: req.extras };
    const engine = engineView(view);
    try {
      const rules: RuleInput[] = await rulesForPackage(tx, view.packageId, view.editionId);
      let promo: PromoInput | null = null;
      let ref: PromoRef | null = null;
      if (req.promoCode !== undefined) {
        const row = await findPromo(tx, req.promoCode);
        if (row) ref = { id: row.id, version: row.version };
        try {
          promo = row ? promoInputOf(row, opts.now) : UNKNOWN_CODE;
          const breakdown = price(request, engine, rates, rules, promo, opts.now);
          return { breakdown, promoRef: breakdown.promo.status === 'applied' ? ref : null };
        } catch (e) {
          if (!(e instanceof PricingError) || e.details.origin !== 'promo') throw e;
          // A code set up wrong is the code's problem, not the customer's: logged, and to the public it reads `invalid`.
          this.logger.warn(`promo code configuration error: ${e.code} ${String(e.details.id ?? '')}`);
          if (opts.audience !== 'public') throw e;
          return { breakdown: price(request, engine, rates, rules, UNKNOWN_CODE, opts.now), promoRef: null };
        }
      }
      return { breakdown: price(request, engine, rates, rules, promo, opts.now), promoRef: null };
    } catch (e) {
      if (e instanceof PricingError) {
        const http = pricingErrorToHttp(e);
        if (http === null || http.code === 'adjustment_above_limit') this.logger.error(`pricing configuration error: ${e.code} ${String(e.details.origin ?? '')} ${String(e.details.id ?? '')}`);
        throw http ?? e;
      }
      throw e;
    }
  }

  private run(req: QuoteRequest | AdminQuoteRequest, audience: 'public' | 'staff'): Promise<PriceBreakdown> {
    const now = new Date();
    return this.prisma.$transaction((tx) => this.priceIn(tx, req, { audience, now }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** The public answer: the breakdown without the rule trace, and one status for any code that was not applied. */
  async quotePublic(req: QuoteRequest) {
    const { trace: _trace, ...b } = await this.run(req, 'public');
    return toJson({ ...b, promo: { status: publicPromoStatus(b.promo.status) } });
  }

  /** The panel's answer: any package that is not deleted, a draft version if asked, and why each rule did or did not apply. */
  async quoteStaff(req: AdminQuoteRequest) {
    return toJson(await this.run(req, 'staff'));
  }
}
