'use client';

import { useState } from 'react';
import type { CancellationQuoteView, CancellationView } from '@mt/shared';
import { Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { tierLineIn } from '@/lib/cancellation';
import { t } from '@/lib/i18n';
import { Section, formatDay, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';
import { crmError } from './crm-kit';

const CANCELLABLE = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid'];

/**
 * Cancelling a booking in the panel (task 6.4). The API works out the tier, what is kept, what is never charged and what
 * may go back; this only shows its quote and sends back the quote's digest with a reason. "We cancelled it" (the race or
 * a supplier let us down) keeps nothing. Every cancellation asks for a step-up code.
 */
export function CancellationPanel({ bookingId, status, version, cancellation, onChanged }: { bookingId: string; status: string; version: number; cancellation: CancellationView | null; onChanged: () => unknown }) {
  const [operator, setOperator] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp();
  const cancellable = CANCELLABLE.includes(status);
  const quote = useLoad<CancellationQuoteView>(cancellable ? `/admin/bookings/${bookingId}/cancellation-quote${operator ? '?operatorCancelled=true' : ''}` : null);

  if (cancellation) return <CancellationRecord c={cancellation} />;
  if (!cancellable) return null;
  const q = quote.data;

  async function cancel() {
    if (!q || busy) return;
    if (!reason.trim()) {
      setMessage({ text: t('admin.crm.booking.reasonRequired'), tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      const r = await stepUp.run(() => api(`/admin/bookings/${bookingId}/cancel`, { method: 'POST', body: { version, reason: reason.trim(), quoteDigest: q.quoteDigest, operatorCancelled: operator } }));
      if (r.status === 200) {
        setMessage({ text: t('admin.crm.booking.done.cancel'), tone: 'info' });
        await onChanged();
      } else {
        if (r.body?.code === 'cancellation_quote_changed') await quote.reload();
        setMessage({ text: crmError(r as { status: number; body: { code?: string } }), tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="booking-cancellation" title={t('admin.crm.cancellation.title')}>
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={operator} onChange={(e) => setOperator(e.target.checked)} aria-describedby="cancel-operator-hint" />
          <span>{t('admin.crm.cancellation.operator')}</span>
        </label>
        <p id="cancel-operator-hint" className="field__hint">{t('admin.crm.cancellation.operatorHint')}</p>
      </div>
      {q ? <QuoteLines q={q} /> : <Status message={quote.error} />}
      {q?.blockedReason ? <p className="notice" role="status">{t(`admin.crm.cancellation.blocked.${q.blockedReason}`)}</p> : null}
      <div className="field">
        <label htmlFor="cancel-reason">{t('admin.crm.booking.reason')}</label>
        <textarea id="cancel-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="actions">
        <button className="btn" type="button" disabled={!q || busy} aria-disabled={!q || busy} onClick={() => void cancel()}>{t('admin.crm.booking.cancel')}</button>
      </div>
      {stepUp.prompt}
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
    </Section>
  );
}

/** The quote as the API gave it: amounts formatted, never added up. */
function QuoteLines({ q }: { q: CancellationQuoteView }) {
  const money = moneyIn(q.currency);
  const tier = q.tier ? tierLineIn(q.policy, q.tier) : null;
  return (
    <dl>
      <dt>{t('admin.crm.cancellation.basis')}</dt>
      <dd>{t(`admin.crm.cancellation.bases.${q.basis}`)}</dd>
      <dt>{t('admin.crm.cancellation.days')}</dt>
      <dd>{t('admin.crm.cancellation.daysLine', { days: String(q.daysBeforeDeparture), date: formatDay(q.effectiveDate) })}</dd>
      {tier ? (
        <>
          <dt>{t('admin.crm.cancellation.tier')}</dt>
          <dd>{t(tier.key, tier.params)}</dd>
        </>
      ) : null}
      <dt>{t('admin.crm.cancellation.held')}</dt>
      <dd>{money(q.heldMinor)}</dd>
      <dt>{t('admin.crm.cancellation.policyPenalty')}</dt>
      <dd>{money(q.policyPenaltyMinor)}</dd>
      <dt>{t('admin.crm.cancellation.kept')}</dt>
      <dd>{money(q.penaltyMinor)}</dd>
      <dt>{t('admin.crm.cancellation.waived')}</dt>
      <dd>{money(q.waivedMinor)}</dd>
      <dt>{t('admin.crm.cancellation.refundable')}</dt>
      <dd>{money(q.refundableMinor)}</dd>
    </dl>
  );
}

function CancellationRecord({ c }: { c: CancellationView }) {
  const money = moneyIn(c.currency);
  return (
    <Section id="booking-cancellation" title={t('admin.crm.cancellation.recordTitle')}>
      <dl>
        <dt>{t('admin.crm.cancellation.basis')}</dt>
        <dd>{t(`admin.crm.cancellation.bases.${c.basis}`)}</dd>
        <dt>{t('admin.crm.cancellation.by')}</dt>
        <dd>{t(`admin.crm.cancellation.requestedBy.${c.requestedBy}`)}</dd>
        <dt>{t('admin.crm.cancellation.days')}</dt>
        <dd>{t('admin.crm.cancellation.daysLine', { days: String(c.daysBeforeDeparture), date: formatDay(c.businessDate) })}</dd>
        <dt>{t('admin.crm.cancellation.policyPenalty')}</dt>
        <dd>{money(c.policyPenaltyMinor)}</dd>
        <dt>{t('admin.crm.cancellation.kept')}</dt>
        <dd>{money(c.penaltyMinor)}</dd>
        <dt>{t('admin.crm.cancellation.waived')}</dt>
        <dd>{money(c.waivedMinor)}</dd>
        <dt>{t('admin.crm.cancellation.refundable')}</dt>
        <dd>{money(c.refundableMinor)}</dd>
      </dl>
    </Section>
  );
}

/** Formats the API's amounts in one currency (formatting only: nothing is added up). */
function moneyIn(currency: string) {
  return function format(minor: string): string {
    return formatMoney(minor, currency);
  };
}
