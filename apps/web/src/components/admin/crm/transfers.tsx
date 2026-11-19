'use client';

import { useState, type FormEvent } from 'react';
import { Field, Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { t } from '@/lib/i18n';
import { toMinor } from '@/lib/supplier-format';
import { Section, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';
import { crmError, formatMoment } from './crm-kit';

interface PaymentRow {
  id: string;
  origin: 'gateway' | 'inbound';
  method: string;
  amountMinor: string;
  currency: string;
  status: string;
  version: number;
  providerPaymentRef: string | null;
  succeededAt: string | null;
}

const METHODS = ['payid_transfer', 'manual_other'] as const;

type Changed = () => unknown;
type Loaded = { booking: { currency: string; reference: string }; payments: PaymentRow[] };
type Confirmed = { transfer: PaymentRow; replayed: boolean };

/**
 * Bank transfers of a booking (task 3.4): staff record money that arrived by PayID or bank transfer, matched by the
 * reference the customer wrote, and can void a transfer entered by mistake. Both actions ask for a step-up code. The
 * amount typed here is the money seen in the bank account; the API checks it and decides what it covers.
 */
export function TransfersPanel({ bookingId, onChanged }: { bookingId: string; onChanged?: Changed }) {
  const { data, reload } = useLoad<Loaded>(`/admin/payments/bookings/${bookingId}`);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const stepUp = useStepUp();
  // Without payments.payment.read the section stays hidden (the API says 403).
  if (!data) return null;
  const currency = data.booking.currency;
  const transfers = data.payments.filter((p) => p.origin === 'inbound');

  const fail = (r: { status: number; body: { code?: string } }) => {
    if (r.status === 403 && r.body.code === 'step_up_required') return t('admin.crm.transfers.stepUpCancelled');
    if (r.status === 403) return t('admin.crm.transfers.forbidden');
    const code = r.body?.code;
    if (code) {
      try {
        return t(`admin.crm.transfers.errors.${code}`);
      } catch {
        /* falls through */
      }
    }
    return crmError(r);
  };

  async function refresh() {
    await reload();
    await onChanged?.();
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const amountMinor = toMinor(String(fd.get('amount') ?? ''), currency);
    if (!amountMinor || /^0+$/.test(amountMinor)) {
      setMessage({ text: t('admin.crm.transfers.errors.amountInvalid'), tone: 'error' });
      return;
    }
    const body = { method: String(fd.get('method')), amountMinor, reference: String(fd.get('reference') ?? '').trim() };
    setBusy(true);
    try {
      const r = await stepUp.run(() => api(`/admin/payments/bookings/${bookingId}/inbound-payments`, { method: 'POST', body }));
      if (r.status === 200) {
        setMessage({ text: t((r.body as Confirmed).replayed ? 'admin.crm.transfers.replayed' : 'admin.crm.transfers.confirmed'), tone: 'info' });
        form.reset();
        await refresh();
      } else setMessage({ text: fail(r), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function voidIt(e: FormEvent<HTMLFormElement>, row: PaymentRow) {
    e.preventDefault();
    if (busy) return;
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (!reason) {
      setMessage({ text: t('admin.crm.transfers.errors.reasonRequired'), tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      const r = await stepUp.run(() => api(`/admin/payments/payments/${row.id}/void`, { method: 'POST', body: { version: row.version, reason } }));
      if (r.status === 200) {
        setVoiding(null);
        setMessage({ text: t('admin.crm.transfers.voided'), tone: 'info' });
        await refresh();
      } else setMessage({ text: fail(r), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="booking-transfers" title={t('admin.crm.transfers.title')}>
      <p>{t('admin.crm.transfers.intro', { reference: data.booking.reference })}</p>
      {transfers.length === 0 ? <p>{t('admin.crm.transfers.none')}</p> : (
        <ul>
          {transfers.map((p) => (
            <li key={p.id}>
              {t('admin.crm.transfers.row', {
                amount: formatMoney(p.amountMinor, p.currency), state: t(`admin.crm.transfers.states.${p.status}`),
                reference: p.providerPaymentRef ?? '', when: p.succeededAt ? formatMoment(p.succeededAt) : '',
              })}
              {p.status === 'succeeded' && voiding !== p.id ? (
                <>
                  {' '}
                  <button className="link-button" type="button" disabled={busy} onClick={() => setVoiding(p.id)}>{t('admin.crm.transfers.void')}</button>
                </>
              ) : null}
              {voiding === p.id ? (
                <form className="stack" onSubmit={(e) => void voidIt(e, p)}>
                  <p>{t('admin.crm.transfers.voidWarning')}</p>
                  <Field label={t('admin.crm.transfers.reason')} id={`reason-${p.id}`} {...{ name: 'reason' }} maxLength={200} required />
                  <div className="actions">
                    <button className="btn" type="submit" disabled={busy}>{t('admin.crm.transfers.voidConfirm')}</button>
                    <button className="link-button" type="button" onClick={() => setVoiding(null)}>{t('admin.crm.transfers.cancel')}</button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form className="stack form" onSubmit={(e) => void confirm(e)} noValidate>
        <h3>{t('admin.crm.transfers.confirmHeading')}</h3>
        <div className="field">
          <label htmlFor="transfer-method">{t('admin.crm.transfers.method')}</label>
          <select id="transfer-method" name="method" defaultValue="payid_transfer">
            {METHODS.map((m) => <option key={m} value={m}>{t(`checkout.methods.${m}`)}</option>)}
          </select>
        </div>
        <Field label={t('admin.crm.transfers.amount', { currency })} id="amount" inputMode="decimal" autoComplete="off" required />
        <Field label={t('admin.crm.transfers.statementId')} id="reference" autoComplete="off" maxLength={100} required />
        <p><button className="btn" type="submit" disabled={busy}>{t('admin.crm.transfers.confirm')}</button></p>
      </form>
      {stepUp.prompt}
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
    </Section>
  );
}
