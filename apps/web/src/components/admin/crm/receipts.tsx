'use client';

import { formatMoney } from '@/lib/builder';
import { t } from '@/lib/i18n-admin';
import { adminReceiptHref, receiptKindLabel } from '@/lib/reconciliation-panel';
import { Section, useLoad } from '../catalogue/kit';
import { formatMoment } from './crm-kit';

interface Doc { number: string; kind: string; issuedAt: string; amountMinor: string; currency: string; receiptNumber: string | null }

/** A booking's receipts and notes (task 4.6), each a PDF built by the API from what it stored when it was issued. */
export function ReceiptsPanel({ bookingId }: { bookingId: string }) {
  const { data } = useLoad<{ documents: Doc[] }>(`/admin/payments/bookings/${bookingId}/receipts`);
  if (!data) return null;
  return (
    <Section id="booking-receipts" title={t('admin.crm.receipts.heading')}>
      {data.documents.length === 0 ? <p>{t('admin.crm.receipts.none')}</p> : (
        <ul>
          {data.documents.map((d) => {
            const href = adminReceiptHref(d.number);
            return (
              <li key={d.number}>
                {t('admin.crm.receipts.row', { title: receiptKindLabel(d.kind), number: d.number, amount: formatMoney(d.amountMinor, d.currency), when: formatMoment(d.issuedAt) })}
                {d.receiptNumber ? t('admin.crm.receipts.about', { receipt: d.receiptNumber }) : null}
                {href ? <> <a href={href} download>{t('admin.crm.receipts.download', { number: d.number })}</a></> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
