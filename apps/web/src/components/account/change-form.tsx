'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import { amendmentErrorKey, customerBody } from '@/lib/amendments';
import type { AmendmentPreview } from '@/lib/amendments';
import { formatMoney } from '@/lib/builder';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';

export interface ChangeFormProps {
  reference: string;
  version: number;
  places: Array<{ slot: number }>;
  nights: { before: number; after: number; maxBefore: number; maxAfter: number };
  extras: Array<{ id: string; name: string; perPerson: boolean; maxPerBooking: number }>;
  current: { perPerson: Record<string, number[]>; perBooking: Record<string, number> };
}

const range = (n: number) => Array.from({ length: n + 1 }, (_, i) => i);

/**
 * A customer's change of nights and extras (task 6.3). The API prices it and says what is left to pay; the page shows its
 * answer as sent and sends nothing but the choices, the preview's digest and the acceptance of the new price.
 */
export function ChangeForm(p: ChangeFormProps) {
  const router = useRouter();
  const [before, setBefore] = useState(p.nights.before);
  const [after, setAfter] = useState(p.nights.after);
  const [perPerson, setPerPerson] = useState<Record<string, number[]>>(p.current.perPerson);
  const [perBooking, setPerBooking] = useState<Record<string, number>>(p.current.perBooking);
  const [preview, setPreview] = useState<AmendmentPreview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => customerBody({ version: p.version, extraNightsBefore: before, extraNightsAfter: after, perPerson, perBooking });
  const changed = () => {
    setPreview(null);
    setAccepted(false);
  };

  async function show() {
    setBusy(true);
    try {
      const r = await api(`/account/bookings/${encodeURIComponent(p.reference)}/amendments/preview`, { method: 'POST', body: body() });
      if (r.status === 200) {
        setPreview(r.body as unknown as AmendmentPreview);
        setError(null);
      } else setError(t(amendmentErrorKey(r.body.code)));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    if (!accepted) {
      setError(t('amendments.acceptRequired'));
      return;
    }
    setBusy(true);
    try {
      const r = await api(`/account/bookings/${encodeURIComponent(p.reference)}/amendments`, {
        method: 'POST', body: { ...body(), previewDigest: preview.previewDigest, acceptNewPrice: true }, headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      if (r.status === 201) router.push(`/account/bookings/${encodeURIComponent(p.reference)}?changed=1`);
      else setError(t(amendmentErrorKey(r.body.code)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void show(); }}>
        {p.nights.maxBefore > 0 ? (
          <div className="field">
            <label htmlFor="change-before">{t('amendments.nightsBefore')}</label>
            <select id="change-before" value={before} onChange={(e) => { setBefore(Number(e.target.value)); changed(); }}>
              {range(p.nights.maxBefore).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        ) : null}
        {p.nights.maxAfter > 0 ? (
          <div className="field">
            <label htmlFor="change-after">{t('amendments.nightsAfter')}</label>
            <select id="change-after" value={after} onChange={(e) => { setAfter(Number(e.target.value)); changed(); }}>
              {range(p.nights.maxAfter).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        ) : null}
        {p.extras.length > 0 ? (
          <fieldset>
            <legend>{t('amendments.extrasLegend')}</legend>
            {p.extras.map((x) => (x.perPerson ? p.places.map((pl) => {
              const on = (perPerson[x.id] ?? []).includes(pl.slot);
              const id = `change-extra-${x.id}-${pl.slot}`;
              return (
                <div key={id} className="field field--check">
                  <input id={id} type="checkbox" checked={on} onChange={() => { setPerPerson({ ...perPerson, [x.id]: on ? (perPerson[x.id] ?? []).filter((s) => s !== pl.slot) : [...(perPerson[x.id] ?? []), pl.slot] }); changed(); }} />
                  <label htmlFor={id}>{t('amendments.extraFor', { extra: x.name, slot: pl.slot })}</label>
                </div>
              );
            }) : (
              <div key={x.id} className="field">
                <label htmlFor={`change-qty-${x.id}`}>{t('amendments.extraQuantity', { extra: x.name })}</label>
                <select id={`change-qty-${x.id}`} value={perBooking[x.id] ?? 0} onChange={(e) => { setPerBooking({ ...perBooking, [x.id]: Number(e.target.value) }); changed(); }}>
                  {range(x.maxPerBooking).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            )))}
          </fieldset>
        ) : null}
        <div className="actions"><button className="btn" type="submit" disabled={busy}>{t('amendments.preview')}</button></div>
      </form>

      {preview ? (
        <section className="stack" aria-labelledby="change-preview-heading" aria-live="polite">
          <h2 id="change-preview-heading">{t('amendments.previewHeading')}</h2>
          <dl>
            <div><dt>{t('amendments.previousTotal')}</dt><dd>{formatMoney(preview.previousTotalMinor, preview.currency)}</dd></div>
            <div><dt>{t('amendments.newTotal')}</dt><dd><strong>{formatMoney(preview.newTotalMinor, preview.currency)}</strong></dd></div>
            <div><dt>{t('amendments.difference')}</dt><dd>{formatMoney(preview.priceDifferenceMinor, preview.currency)}</dd></div>
            <div><dt>{t('amendments.outstandingAfter')}</dt><dd>{formatMoney(preview.outstandingAfterMinor, preview.currency)}</dd></div>
            <div><dt>{t('account.dates')}</dt><dd>{t('account.dateRange', { from: formatDate(preview.departureDate), to: formatDate(preview.returnDate) })}</dd></div>
          </dl>
          <p>{t('amendments.dueNote')}</p>
          <div className="field field--check">
            <input id="change-accept" type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <label htmlFor="change-accept">{t('amendments.accept')}</label>
          </div>
          <div className="actions"><button className="btn" type="button" disabled={busy} onClick={() => void confirm()}>{t('amendments.confirm')}</button></div>
        </section>
      ) : null}
      {error ? <p className="notice notice--error" role="alert">{error}</p> : null}
      <p><Link href={`/account/bookings/${encodeURIComponent(p.reference)}`}>{t('amendments.back')}</Link></p>
    </div>
  );
}
