// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, section 5): the accountant's files. The read and its audit entry are
// one transaction: no entry, no file. The entry says who exported what and how many rows, never a value.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ACCOUNTANT_MAX_DAYS, type AccountantDataset } from '@mt/shared';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { unprocessable } from '../../../platform/http/api-error';
import { addDays } from './cash-forecast';
import { ProviderGateway } from './gateway';
import { impliedRateE9 } from './fx';
import {
  EXPORT_MAX_ROWS, LEDGER_HEADER, SUPPLIER_PAYMENTS_HEADER, TRIP_RESULT_HEADER, type ExportCell, type LedgerExportRow, type SupplierPaymentExportRow,
  exportFilename, ledgerRows, renderExport, supplierPaymentRows, tripResultRows,
} from './accountant-export';
import { TripResultService } from './trip-result.service';

export interface AccountantFile { filename: string; body: string; rowCount: number }

const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};

@Injectable()
export class AccountantExportService {
  /** The most rows of one file (a field so a test can lower it). */
  maxRows = EXPORT_MAX_ROWS;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(TripResultService) private readonly results: TripResultService,
  ) {}

  async generate(actor: AuditActor & { id: string }, body: { dataset: AccountantDataset; from: string; to: string }, now = new Date()): Promise<AccountantFile> {
    if (body.to < body.from) throw unprocessable('range_invalid', 'The last day is before the first day');
    if (addDays(body.from, ACCOUNTANT_MAX_DAYS - 1) < body.to) throw unprocessable('range_too_long', 'Choose a range of 366 days or less');
    const mode = this.gateway.mode;
    return this.prisma.$transaction(async (tx) => {
      let header: readonly string[];
      let rows: ExportCell[][];
      let currencies: string[];
      if (body.dataset === 'trip_result') {
        const report = await this.results.reportIn(tx, now);
        header = TRIP_RESULT_HEADER;
        rows = tripResultRows(mode, report.rows);
        currencies = [...new Set(report.rows.map((r) => r.currency))];
      } else if (body.dataset === 'ledger') {
        const data = await this.ledger(tx, mode, body.from, body.to);
        header = LEDGER_HEADER;
        rows = ledgerRows(mode, data);
        currencies = [...new Set(data.map((r) => r.currency))];
      } else {
        const data = await this.supplierPayments(tx, mode, body.from, body.to);
        header = SUPPLIER_PAYMENTS_HEADER;
        rows = supplierPaymentRows(mode, data);
        currencies = [...new Set(data.flatMap((r) => [r.currency, ...(r.bankCurrency ? [r.bankCurrency] : [])]))];
      }
      if (rows.length > this.maxRows) throw unprocessable('export_too_large', 'That is too many rows for one file: choose fewer dates');
      const csv = renderExport(header, rows);
      await this.audit.record(tx, {
        actor, action: 'exports.accountant.generated', entityType: 'AccountantExport', entityId: randomUUID(),
        after: { dataset: body.dataset, from: body.from, to: body.to, mode, rowCount: rows.length, currencies: currencies.sort() },
        fieldClasses: { dataset: 'nopii', from: 'nopii', to: 'nopii', mode: 'nopii', rowCount: 'nopii', currencies: 'nopii' },
      });
      return { filename: exportFilename(body.dataset, body.from, body.to), body: csv, rowCount: rows.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 });
  }

  private async tripNames(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, string>> {
    const pkgs = await tx.package.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, edition: { select: { year: true, race: { select: { name: true } } } } } });
    return new Map(pkgs.map((p) => [p.id, `${en(p.edition.race.name)} ${p.edition.year}: ${en(p.name)}`]));
  }

  private async ledger(tx: Prisma.TransactionClient, mode: string, from: string, to: string): Promise<LedgerExportRow[]> {
    const rows = await tx.$queryRaw<Array<{ date: Date; key: string; kind: string; account: string; currency: string; amount: bigint; reference: string | null; packageId: string | null; supplier: string | null }>>`
      SELECT (t."occurredAt" AT TIME ZONE 'Australia/Brisbane')::date AS date, t."idempotencyKey" AS key, t.kind::text AS kind, e."accountCode" AS account, e.currency, e."amountMinor" AS amount,
        b.reference, b."packageId"::text AS "packageId", s.name AS supplier
      FROM ledger_entries e JOIN ledger_transactions t ON t.id = e."transactionId" AND t.mode = e.mode
        LEFT JOIN bookings b ON b.id = t."bookingId"
        LEFT JOIN supplier_payments sp ON sp.id = t."supplierPaymentId" LEFT JOIN suppliers s ON s.id = sp."supplierId"
      WHERE e.mode = ${mode}::"PaymentMode" AND (t."occurredAt" AT TIME ZONE 'Australia/Brisbane')::date BETWEEN ${from}::date AND ${to}::date
      ORDER BY t."occurredAt", t.id, e.id LIMIT ${this.maxRows + 1}`;
    const names = await this.tripNames(tx, [...new Set(rows.map((r) => r.packageId).filter((x): x is string => !!x))]);
    return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), key: r.key, kind: r.kind, account: r.account, currency: r.currency, amountMinor: r.amount, bookingReference: r.reference, trip: r.packageId ? (names.get(r.packageId) ?? null) : null, supplier: r.supplier }));
  }

  private async supplierPayments(tx: Prisma.TransactionClient, mode: string, from: string, to: string): Promise<SupplierPaymentExportRow[]> {
    const rows = await tx.$queryRaw<Array<{ paidOn: Date; recordedOn: Date; supplier: string; status: string; currency: string; amount: bigint; baseCurrency: string | null; baseAmount: bigint | null; packageId: string | null; trips: number; unlinked: boolean; items: number }>>`
      SELECT sp."paidOn", (sp."recordedAt" AT TIME ZONE 'Australia/Brisbane')::date AS "recordedOn", s.name AS supplier, sp.status::text AS status, sp.currency, sp."amountMinor" AS amount,
        sp."baseCurrency", sp."baseAmountMinor" AS "baseAmount", min(c."packageId"::text) AS "packageId", count(DISTINCT c."packageId")::int AS trips, bool_or(c."packageId" IS NULL) AS unlinked, count(i.id)::int AS items
      FROM supplier_payments sp JOIN suppliers s ON s.id = sp."supplierId" JOIN supplier_payment_items i ON i."supplierPaymentId" = sp.id JOIN cost_items c ON c.id = i."costItemId"
      WHERE sp.mode = ${mode}::"PaymentMode" AND sp."paidOn" BETWEEN ${from}::date AND ${to}::date
      GROUP BY sp.id, s.name ORDER BY sp."paidOn", sp.id LIMIT ${this.maxRows + 1}`;
    const names = await this.tripNames(tx, [...new Set(rows.map((r) => r.packageId).filter((x): x is string => !!x))]);
    return rows.map((r) => ({
      paidOn: r.paidOn.toISOString().slice(0, 10), recordedOn: r.recordedOn.toISOString().slice(0, 10), supplier: r.supplier, status: r.status, currency: r.currency, amountMinor: r.amount,
      bankCurrency: r.baseCurrency, bankAmountMinor: r.baseAmount,
      rateE9: r.baseAmount !== null && r.baseCurrency ? impliedRateE9(r.amount, r.currency, r.baseAmount, r.baseCurrency) : null,
      trip: r.trips === 1 && !r.unlinked && r.packageId ? (names.get(r.packageId) ?? null) : null, items: r.items,
    }));
  }
}
