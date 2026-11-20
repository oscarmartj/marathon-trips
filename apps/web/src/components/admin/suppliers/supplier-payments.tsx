'use client';

import { useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { formatMinor } from '@/lib/supplier-format';
import { newIdempotencyKey, paymentErrorMessage, recordBody } from '@/lib/supplier-payments';
import { Field, Status } from '../../auth/field';
import { Section, formatDay, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';

interface Cost { id: string; description: string; amountMinor: string; currency: string; dueDate: string | null; status: string; version: number }
interface Payment {
  id: string; amountMinor: string; currency: string; base: { amountMinor: string; currency: string } | null; paidOn: string; reference: string; status: 'recorded' | 'voided';
  voidReason: string | null; version: number; items: Array<{ costItemId: string }>;
}
type Message = { text: string; tone: 'info' | 'error' } | null;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());

/**
 * Task 6.2: payments to one supplier. Recording does not send money; it records a payment already made from the bank. The
 * total shown is the API's (preview), and the API works out the amount again when recording.
 */
export function SupplierPayments({ supplierId, costs, onChange }: { supplierId: string; costs: Cost[]; onChange: () => void }) {
  const payments = useLoad<{ items: Payment[] }>(`/admin/suppliers/${supplierId}/payments`);
  const stepUp = useStepUp();
  const owed = costs.filter((c) => c.status === 'planned' || c.status === 'due');
  const [selected, setSelected] = useState([] as string[]);
  const [total, setTotal] = useState(null as string | null);
  const [message, setMessage] = useState(null as Message);
  const [busy, setBusy] = useState(false);
  // One key per submission: a retry of the same submission reuses it; a new one after success gets a fresh key.
  const recordKey = useRef(newIdempotencyKey());

  const chosen = owed.filter((c) => selected.includes(c.id));
  const toggle = (id: string) => { setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])); setTotal(null); };
  const fail = (code: string | undefined, status?: number) => setMessage({ text: paymentErrorMessage(code, status), tone: 'error' });
  const reloadAll = () => { void payments.reload(); onChange(); };

  async function check() {
    const r = await api<{ amountMinor: string; currency: string }>(`/admin/suppliers/${supplierId}/payments/preview`, { method: 'POST', body: { items: chosen.map((c) => ({ costItemId: c.id, version: c.version })) } });
    if (r.status === 200) {
      const b = r.body as unknown as { amountMinor: string; currency: string };
      setTotal(formatMinor(b.amountMinor, b.currency));
      setMessage(null);
    } else fail((r.body as { code?: string }).code, r.status);
  }

  async function record(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    const body = recordBody(chosen, String(f.get('paidOn') ?? ''), String(f.get('reference') ?? ''), String(f.get('baseAmount') ?? ''), String(f.get('baseCurrency') ?? ''));
    if ('error' in body) return setMessage({ text: body.error, tone: 'error' });
    setBusy(true);
    try {
      const key = recordKey.current;
      const r = await stepUp.run(() => api(`/admin/suppliers/${supplierId}/payments`, { method: 'POST', body, headers: { 'Idempotency-Key': key } }));
      if (r.status === 200 || r.status === 201) {
        recordKey.current = newIdempotencyKey();
        setSelected([]);
        setTotal(null);
        setMessage({ text: t('admin.suppliers.payments.recorded'), tone: 'info' });
        (e.target as HTMLFormElement).reset();
        reloadAll();
      } else fail((r.body as { code?: string }).code, r.status);
    } finally {
      setBusy(false);
    }
  }

  async function voidPayment(p: Payment, reason: string) {
    const key = newIdempotencyKey();
    const r = await stepUp.run(() => api(`/admin/suppliers/payments/${p.id}/void`, { method: 'POST', body: { version: p.version, reason }, headers: { 'Idempotency-Key': key } }));
    if (r.status === 200) {
      setMessage({ text: t('admin.suppliers.payments.voided'), tone: 'info' });
      reloadAll();
    } else fail((r.body as { code?: string }).code, r.status);
  }

  return (
    <Section id="supplier-payments" title={t('admin.suppliers.payments.title')}>
      <p role="note" id="supplier-payments-notice"><strong>{t('admin.suppliers.payments.notice')}</strong></p>
      {stepUp.prompt}
      <Status message={message?.text ?? null} tone={message?.tone} />

      {owed.length === 0 ? <p role="status">{t('admin.suppliers.payments.owedEmpty')}</p> : (
        <form className="stack form" onSubmit={(e) => void record(e)} aria-describedby="supplier-payments-notice">
          <fieldset>
            <legend>{t('admin.suppliers.payments.chooseFirst')}</legend>
            {owed.map((c) => (
              <div key={`${c.id}-${c.version}`} className="field field--checkbox">
                <input id={`pay-${c.id}`} type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                <label htmlFor={`pay-${c.id}`}>{t('admin.suppliers.payments.owedItem', { description: c.description, amount: formatMinor(c.amountMinor, c.currency), date: c.dueDate ? formatDay(c.dueDate) : t('admin.suppliers.allotments.noDate') })}</label>
              </div>
            ))}
          </fieldset>
          <p>
            <button className="btn" type="button" disabled={chosen.length === 0} onClick={() => void check()}>{t('admin.suppliers.payments.check')}</button>{' '}
            {total ? <span role="status">{t('admin.suppliers.payments.total', { amount: total })}</span> : null}
          </p>
          <Field label={t('admin.suppliers.payments.paidOn')} id="paidOn" type="date" required defaultValue={today()} max={today()} />
          <Field label={t('admin.suppliers.payments.reference')} id="reference" required maxLength={80} />
          <Field label={t('admin.suppliers.payments.baseAmount')} id="baseAmount" inputMode="decimal" />
          <Field label={t('admin.suppliers.payments.baseCurrency')} id="baseCurrency" maxLength={3} />
          <div className="actions"><button className="btn" type="submit" disabled={busy}>{t('admin.suppliers.payments.record')}</button></div>
        </form>
      )}

      <Status message={payments.error} />
      {payments.data && payments.data.items.length === 0 ? <p role="status">{t('admin.suppliers.payments.listEmpty')}</p> : null}
      <ul className="stack">
        {(payments.data?.items ?? []).map((p) => (
          <li key={`${p.id}-${p.version}`} className="stack">
            <span>{t('admin.suppliers.payments.line', { date: formatDay(p.paidOn), amount: formatMinor(p.amountMinor, p.currency), reference: p.reference })}</span>
            {p.base ? <span>{t('admin.suppliers.payments.baseLine', { amount: formatMinor(p.base.amountMinor, p.base.currency) })}</span> : null}
            <span className="badge">{t(`admin.suppliers.payments.statuses.${p.status}`)}</span>
            {p.status === 'voided' ? <span>{t('admin.suppliers.payments.voidedLine', { description: p.voidReason ?? '' })}</span> : (
              <details>
                <summary>{t('admin.suppliers.payments.void')}</summary>
                <form className="stack form" onSubmit={(e) => { e.preventDefault(); void voidPayment(p, String(new FormData(e.currentTarget).get(`void-${p.id}`) ?? '').trim()); }}>
                  <p className="field__hint">{t('admin.suppliers.payments.voidHint')}</p>
                  <Field label={t('admin.suppliers.payments.voidReason')} id={`void-${p.id}`} required maxLength={500} />
                  <div className="actions"><button className="btn" type="submit">{t('admin.suppliers.payments.void')}</button></div>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>

    </Section>
  );
}
