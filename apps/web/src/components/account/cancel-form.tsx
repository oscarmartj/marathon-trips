'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { CancellationQuoteView } from '@mt/shared';
import { Status } from '@/components/auth/field';
import { CancellationPolicyTerms } from '@/components/cancellation/policy-terms';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { formatDate } from '@/lib/catalogue-format';
import { tierLine } from '@/lib/cancellation';
import { newIdempotencyKey } from '@/lib/checkout';
import { t } from '@/lib/i18n';

const errorKey = (code: string | undefined): string => {
  if (code === 'cancellation_quote_changed') return 'cancellation.page.errors.cancellation_quote_changed';
  if (code && code.startsWith('cancellation_blocked') || code?.startsWith('customer_')) return `cancellation.page.blocked.${code}`;
  return 'cancellation.page.errors.generic';
};

/**
 * The customer's own cancellation (task 6.4). It shows the API's quote (the tier, what is kept, what is not charged and
 * what goes back) and sends back only its digest: if anything changed meanwhile, the API refuses and the page shows the
 * new quote. One Idempotency-Key per page, so a second click is the same cancellation.
 */
export function CancelForm({ reference, initial }: { reference: string; initial: CancellationQuoteView }) {
  const [q, setQ] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const money = moneyIn(q.currency);
  const tier = q.tier ? tierLine(q.tier, null) : null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/account/bookings/${encodeURIComponent(reference)}/cancel`, { method: 'POST', body: { quoteDigest: q.quoteDigest }, headers: { 'Idempotency-Key': key.current } });
      if (r.status === 200 || r.status === 201) {
        setDone(true);
        return;
      }
      setError(t(errorKey(r.body?.code)));
      if (r.body?.code === 'cancellation_quote_changed') {
        const fresh = await api<CancellationQuoteView>(`/account/bookings/${encodeURIComponent(reference)}/cancellation-quote`);
        if (fresh.status === 200) setQ(fresh.body as unknown as CancellationQuoteView);
        key.current = newIdempotencyKey();
      }
    } catch {
      setError(t('cancellation.page.errors.network'));
    } finally {
      setBusy(false);
    }
  }

  const back = <p><Link href={`/account/bookings/${encodeURIComponent(reference)}`}>{t('cancellation.page.back')}</Link></p>;
  if (done) return <div className="stack"><p className="notice" role="status">{t('cancellation.page.done')}</p>{back}</div>;
  return (
    <div className="stack">
      <p>{t('cancellation.page.intro')}</p>
      <dl>
        <dt>{t('cancellation.page.days')}</dt>
        <dd>{t('cancellation.page.daysLine', { days: String(q.daysBeforeDeparture), date: formatDate(q.effectiveDate) })}</dd>
        {tier ? (
          <>
            <dt>{t('cancellation.page.tier')}</dt>
            <dd>{t(tier.key, tier.params)}</dd>
          </>
        ) : null}
        <dt>{t('cancellation.page.paid')}</dt>
        <dd>{money(q.heldMinor)}</dd>
        <dt>{t('cancellation.page.kept')}</dt>
        <dd>{money(q.penaltyMinor)}</dd>
        {q.waivedMinor !== '0' ? (
          <>
            <dt>{t('cancellation.page.notCharged')}</dt>
            <dd>{money(q.waivedMinor)}</dd>
          </>
        ) : null}
        <dt>{t('cancellation.page.refund')}</dt>
        <dd>{money(q.refundableMinor)}</dd>
      </dl>
      <p className="field__hint">{t('cancellation.page.refundNote')}</p>
      <CancellationPolicyTerms policy={q.policy} />
      {q.blockedReason ? <p className="notice" role="status">{t(`cancellation.page.blocked.${q.blockedReason}`)}</p> : null}
      <Status message={error} />
      {q.blockedReason ? null : (
        <p><button className="btn" type="button" disabled={busy} aria-disabled={busy} onClick={() => void confirm()}>{busy ? t('cancellation.page.working') : t('cancellation.page.confirm')}</button></p>
      )}
      {back}
    </div>
  );
}

/** Formats the API's amounts in one currency (formatting only: nothing is added up). */
function moneyIn(currency: string) {
  return function format(minor: string): string {
    return formatMoney(minor, currency);
  };
}
