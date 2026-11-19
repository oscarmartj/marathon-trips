import { Inject, Injectable } from '@nestjs/common';
import type { ManualInstructionsView, ManualMethodConfigInput, ManualPaymentMethod, PaymentMethod } from '@mt/shared';
import { MANUAL_PAYMENT_METHODS } from '@mt/shared';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { conflict, notFound, unprocessable } from '../../../platform/http/api-error';
import { bsbDigits, configProblems, payeeProblems } from '../adapters/manual/instructions';
import type { PayeeDetails } from '../adapters/manual/instructions';

type Db = Prisma.TransactionClient | PrismaService;

export const isManualMethod = (m: string): m is ManualPaymentMethod => (MANUAL_PAYMENT_METHODS as readonly string[]).includes(m);

interface ConfigRow {
  id: string;
  method: PaymentMethod;
  enabled: boolean;
  countries: string[];
  displayOrder: number;
  instructions: unknown;
  payeeName: string | null;
  payIdType: 'email' | 'phone' | 'abn' | 'org_id' | null;
  payId: string | null;
  bsb: string | null;
  accountNumber: string | null;
  version: number;
}

const SELECT = { id: true, method: true, enabled: true, countries: true, displayOrder: true, instructions: true, payeeName: true, payIdType: true, payId: true, bsb: true, accountNumber: true, version: true } as const;

const payeeOf = (r: ConfigRow): PayeeDetails => ({
  payeeName: r.payeeName,
  payId: r.payId && r.payIdType ? { type: r.payIdType, value: r.payId } : null,
  bank: r.bsb && r.accountNumber ? { bsb: r.bsb, accountNumber: r.accountNumber } : null,
});

/** The note staff wrote, in en-AU (the one language every method has). */
const noteOf = (instructions: unknown): string | null => {
  if (!instructions || typeof instructions !== 'object') return null;
  const v = (instructions as Record<string, unknown>)['en-AU'];
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/**
 * The manual payment methods' configuration (task 3.4, plan section 5): whether PayID or another transfer is offered,
 * where, and the business's own payee details. Editing needs step-up (the route's permission) and is audited.
 */
@Injectable()
export class ManualMethodsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Every manual method, with a default row (off, no details) for those never configured. */
  async list(): Promise<Array<ReturnType<typeof view>>> {
    const rows = (await this.prisma.paymentMethodConfig.findMany({ select: SELECT })) as ConfigRow[];
    return MANUAL_PAYMENT_METHODS.map((m) => view(m, rows.find((r) => r.method === m)));
  }

  /**
   * `guard` (task 4.1, plan 15.5) wraps the change in the same transaction: the coverage check of CollectionCoverageGuard,
   * which takes the advisory lock first and rolls the change back if it would leave a country without a way to pay.
   */
  async put(method: string, input: ManualMethodConfigInput, actor: AuditActor, guard?: (tx: Prisma.TransactionClient, change: () => Promise<void>) => Promise<unknown>): Promise<ReturnType<typeof view>> {
    if (!isManualMethod(method)) throw notFound('payment_method_not_found', 'No such manual payment method');
    const problems = configProblems({ enabled: input.enabled, countries: input.countries, payeeName: input.payeeName, payId: input.payId, bank: input.bank });
    // Saved details may be incomplete while the method is off; a method that is on needs valid ones.
    if (input.enabled && problems.length > 0) throw unprocessable('payee_details_invalid', `The payment details are not valid: ${problems.join(', ')}`);
    if (!input.enabled && (input.payId || input.bank)) {
      const p = payeeProblems({ payeeName: input.payeeName ?? 'x', payId: input.payId, bank: input.bank }).filter((c) => c !== 'payee_name_missing');
      if (p.length > 0) throw unprocessable('payee_details_invalid', `The payment details are not valid: ${p.join(', ')}`);
    }
    if (input.instructions && !input.instructions['en-AU']) throw unprocessable('instructions_need_en_au', 'The instructions need an en-AU text');
    const data = methodData(input);
    return runTransaction(this.prisma, async (tx) => {
      if (!guard) return this.change(tx, method, input, data, actor);
      let out: ReturnType<typeof view> | undefined;
      await guard(tx, async () => {
        out = await this.change(tx, method, input, data, actor);
      });
      return out!;
    });
  }

  private async change(tx: Prisma.TransactionClient, method: ManualPaymentMethod, input: ManualMethodConfigInput, data: ReturnType<typeof methodData>, actor: AuditActor): Promise<ReturnType<typeof view>> {
    const before = (await tx.paymentMethodConfig.findUnique({ where: { method }, select: SELECT })) as ConfigRow | null;
    if (!before && input.version !== 0) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
    let after: ConfigRow;
    if (!before) {
      after = (await tx.paymentMethodConfig.create({ data: { method, ...data, instructions: (input.instructions ?? Prisma.DbNull) as Prisma.InputJsonValue, updatedById: actor.id }, select: SELECT })) as ConfigRow;
    } else {
      const n = await tx.paymentMethodConfig.updateMany({
        where: { method, version: input.version },
        data: { ...data, instructions: (input.instructions ?? Prisma.DbNull) as Prisma.InputJsonValue, version: { increment: 1 }, updatedById: actor.id },
      });
      if (n.count !== 1) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      after = (await tx.paymentMethodConfig.findUniqueOrThrow({ where: { method }, select: SELECT })) as ConfigRow;
    }
    await this.audit.record(tx, {
      actor, action: 'payments.methodConfig.updated', entityType: 'PaymentMethodConfig', entityId: after.id, model: 'PaymentMethodConfig',
      before: before ? { ...before } : null, after: { ...after },
      context: { method, enabled: after.enabled },
    });
    return view(method, after);
  }

  /** The "connection test" of a manual method: is it set up well enough for a customer to pay with it. */
  async test(method: string): Promise<{ ok: true } | { ok: false; problems: string[] }> {
    if (!isManualMethod(method)) throw notFound('payment_method_not_found', 'No such manual payment method');
    const row = (await this.prisma.paymentMethodConfig.findUnique({ where: { method }, select: SELECT })) as ConfigRow | null;
    const problems = row ? configProblems({ enabled: true, countries: row.countries, ...payeeOf(row) }) : ['not_configured'];
    return problems.length === 0 ? { ok: true } : { ok: false, problems };
  }

  /** The connection test of a manual account (task 4.1): at least one manual method is on and set up well enough. */
  async anyReady(): Promise<boolean> {
    const rows = (await this.prisma.paymentMethodConfig.findMany({ where: { enabled: true }, select: SELECT })) as ConfigRow[];
    return rows.some((r) => isManualMethod(r.method) && configProblems({ enabled: true, countries: r.countries, ...payeeOf(r) }).length === 0);
  }

  /** Whether this manual method is offered to a customer living in `country`: on, listed, and with valid details. */
  async offered(db: Db, method: PaymentMethod, country: string): Promise<boolean> {
    if (!isManualMethod(method)) return false;
    const row = (await db.paymentMethodConfig.findUnique({ where: { method }, select: SELECT })) as ConfigRow | null;
    return !!row && row.enabled && row.countries.includes(country) && payeeProblems(payeeOf(row)).length === 0;
  }

  /** What the customer is shown for an open transfer request. Null if the method is no longer set up. */
  async instructionsFor(db: Db, p: { method: string; amountMinor: bigint; currency: string; reference: string; expiresAt: Date }): Promise<ManualInstructionsView | null> {
    if (!isManualMethod(p.method)) return null;
    const row = (await db.paymentMethodConfig.findUnique({ where: { method: p.method }, select: SELECT })) as ConfigRow | null;
    if (!row || payeeProblems(payeeOf(row)).length > 0) return null;
    const payee = payeeOf(row);
    return {
      method: p.method, reference: p.reference, amountMinor: p.amountMinor.toString(), currency: p.currency, payeeName: payee.payeeName!,
      payId: payee.payId, bank: payee.bank ? { bsb: `${payee.bank.bsb.slice(0, 3)}-${payee.bank.bsb.slice(3)}`, accountNumber: payee.bank.accountNumber } : null,
      note: noteOf(row.instructions), expiresAt: p.expiresAt.toISOString(),
    };
  }
}

const methodData = (input: ManualMethodConfigInput) => ({
  enabled: input.enabled, countries: [...new Set(input.countries)].sort(), displayOrder: input.displayOrder,
  payeeName: input.payeeName, payIdType: input.payId?.type ?? null, payId: input.payId?.value ?? null,
  bsb: input.bank ? bsbDigits(input.bank.bsb) : null, accountNumber: input.bank?.accountNumber ?? null,
});

function view(method: ManualPaymentMethod, r: ConfigRow | undefined) {
  const base = r ? payeeOf(r) : { payeeName: null, payId: null, bank: null };
  return {
    method, version: r?.version ?? 0, enabled: r?.enabled ?? false, countries: r?.countries ?? [], displayOrder: r?.displayOrder ?? 0,
    instructions: (r?.instructions as Record<string, string> | null) ?? null, ...base,
    problems: configProblems({ enabled: true, countries: r?.countries ?? [], ...base }),
  };
}
