import { Inject, Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { SettingsService } from '../../../platform/flags/flags.service';
import { conflict } from '../../../platform/http/api-error';
import { lostCoverage } from './account-rules';
import { PaymentRouting } from './routing';

type Tx = Prisma.TransactionClient;

/** Customers are charged in AUD (plan 0.1, 1.1): the currency whose coverage the warnings watch. */
export const COVERAGE_CURRENCY = 'AUD';
const SALES_COUNTRIES = { key: 'salesCountries', fallback: ['AU'] as string[] };

export type Coverage = Array<{ method: PaymentMethod; country: string }>;

/**
 * "Do not leave me without a way to be paid" (plan 4.1, section 5 and 15.5). Every change that can stop a method being
 * offered (pausing or retiring an account, switching a manual method off) runs inside `guard`: one advisory lock for all
 * of them, so two people switching off the last two ways at once cannot both miss the warning; coverage before; the
 * change; coverage after, seen through the same transaction. A loss without confirmation throws, which rolls it back.
 */
@Injectable()
export class CollectionCoverageGuard {
  constructor(
    @Inject(PaymentRouting) private readonly routing: PaymentRouting,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async lock(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payments.collection_coverage'))`;
  }

  async coverage(tx: Tx, excludeAccountIds: readonly string[] = []): Promise<Coverage> {
    const countries = await this.settings.get<string[]>(SALES_COUNTRIES.key, SALES_COUNTRIES.fallback);
    return this.routing.coverage(tx, { countries, currency: COVERAGE_CURRENCY }, excludeAccountIds);
  }

  /** The sales countries where no method at all is offered (a warning in the panel). */
  async countriesWithoutMethod(tx: Tx): Promise<string[]> {
    const countries = await this.settings.get<string[]>(SALES_COUNTRIES.key, SALES_COUNTRIES.fallback);
    const covered = new Set((await this.coverage(tx)).map((c) => c.country));
    return [...countries].sort().filter((c) => !covered.has(c));
  }

  /** Runs `change` (already under `lock`) and returns what it made unavailable; throws 409 if that was not confirmed. */
  async guard(tx: Tx, confirmed: boolean, change: () => Promise<void>): Promise<Coverage> {
    const before = await this.coverage(tx);
    await change();
    const lost = lostCoverage(before, await this.coverage(tx));
    if (lost.length > 0 && !confirmed) {
      throw conflict('coverage_loss_unconfirmed', 'Customers would lose a way to pay. Confirm to go ahead.', { lost });
    }
    return lost;
  }
}
