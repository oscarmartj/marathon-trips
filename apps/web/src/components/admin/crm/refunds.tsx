'use client';

import { useState, type FormEvent } from 'react';
import { Field, Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { t } from '@/lib/i18n';
import { canMarkEvidence, canRequest, canResolve, destinationBody, isLatePending, manualStep, newIdempotencyKey, refundBody } from '@/lib/refunds-panel';
import type { DisputeRow, RefundRow, RefundableRow } from '@/lib/refunds-panel';
import { Section, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';
import { crmError, formatMoment } from './crm-kit';

type Loaded = { refundable: RefundableRow[]; refunds: RefundRow[]; disputes: DisputeRow[]; depositReversed: boolean };
type Message = { text: string; tone: 'error' | 'info' } | null;
type Call = Parameters<ReturnType<typeof useStepUp>['run']>[0];
type Revealed = { accountName: string; payId: { value: string } | null; bank: { bsb: string; accountNumber: string } | null };

function amountOf(minor: string, currency: string): string {
  return formatMoney(minor, currency);
}

/**
 * Refunds and disputes of a booking (task 4.5). A refund returns what a payment holds beyond what the booking owes: the
 * amount comes from the API and is only shown here. Refunds of bank transfers are sent by staff from the bank, then
 * confirmed with the bank's reference. Every money action asks for a step-up code.
 */
export function RefundsPanel({ bookingId, onChanged }: { bookingId: string; onChanged?: () => unknown }) {
  const { data, reload } = useLoad<Loaded>(`/admin/payments/bookings/${bookingId}/refunds`);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const stepUp = useStepUp();
  if (!data) return null;

  const fail = (r: { status: number; body: { code?: string } }) => {
    if (r.status === 403 && r.body.code === 'step_up_required') return t('admin.crm.refunds.stepUpCancelled');
    if (r.status === 403) return t('admin.crm.refunds.forbidden');
    const code = r.body?.code;
    if (code) {
      try {
        return t(`admin.crm.refunds.errors.${code}`);
      } catch {
        /* falls through */
      }
    }
    return crmError(r);
  };

  async function run(call: Call, ok: string) {
    if (busy) return false;
    setBusy(true);
    try {
      const r = await stepUp.run(call);
      if (r.status >= 200 && r.status < 300) {
        setMessage({ text: t(r.status === 202 ? 'admin.crm.refunds.waiting' : ok), tone: 'info' });
        await reload();
        await onChanged?.();
        return true;
      }
      setMessage({ text: fail(r as { status: number; body: { code?: string } }), tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function request(e: FormEvent<HTMLFormElement>, row: RefundableRow) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (reason.length < 3) {
      setMessage({ text: t('admin.crm.refunds.errors.reasonRequired'), tone: 'error' });
      return;
    }
    const key = newIdempotencyKey();
    if (await run(() => api(`/admin/payments/payments/${row.paymentId}/refunds`, { method: 'POST', body: refundBody(row, reason), headers: { 'Idempotency-Key': key } }), 'admin.crm.refunds.requested')) setAsking(null);
  }

  async function destination(e: FormEvent<HTMLFormElement>, r: RefundRow) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? '');
    await run(() => api(`/admin/payments/refunds/${r.id}/destination`, {
      method: 'PUT',
      body: destinationBody(r.version, { accountName: get('accountName'), kind: get('kind') === 'payid' ? 'payid' : 'bank', payIdType: get('payIdType'), payId: get('payId'), bsb: get('bsb'), accountNumber: get('accountNumber') }),
    }), 'admin.crm.refunds.destinationSaved');
  }

  async function reveal(r: RefundRow) {
    const res = await stepUp.run(() => api(`/admin/payments/refunds/${r.id}/destination`));
    if (res.status !== 200) {
      setMessage({ text: fail(res as { status: number; body: { code?: string } }), tone: 'error' });
      return;
    }
    const d = res.body as unknown as Revealed;
    const where = d.payId ? t('admin.crm.refunds.toPayId', { value: d.payId.value }) : t('admin.crm.refunds.toBank', { bsb: d.bank!.bsb, account: d.bank!.accountNumber });
    setShown((s) => ({ ...s, [r.id]: `${d.accountName}, ${where}` }));
  }

  async function confirm(e: FormEvent<HTMLFormElement>, r: RefundRow) {
    e.preventDefault();
    const bankReference = String(new FormData(e.currentTarget).get('bankReference') ?? '').trim();
    if (!bankReference) {
      setMessage({ text: t('admin.crm.refunds.errors.bankReferenceRequired'), tone: 'error' });
      return;
    }
    if (await run(() => api(`/admin/payments/refunds/${r.id}/confirm-manual`, { method: 'POST', body: { version: r.version, bankReference } }), 'admin.crm.refunds.confirmed')) {
      setShown((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== r.id)));
    }
  }

  /** The evidence package needs a step-up code, so it is fetched here and saved as a file. */
  async function download(d: DisputeRow) {
    const res = await stepUp.run(() => api(`/admin/payments/disputes/${d.id}/evidence`));
    if (res.status !== 200) {
      setMessage({ text: fail(res as { status: number; body: { code?: string } }), tone: 'error' });
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(res.body, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `dispute-${d.providerDisputeRef.replace(/[^A-Za-z0-9_-]/g, '_')}-evidence.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Section id="booking-refunds" title={t('admin.crm.refunds.title')}>
      <p>{t('admin.crm.refunds.intro')}</p>
      {data.depositReversed ? <p className="notice" role="status">{t('admin.crm.refunds.depositReversed')}</p> : null}
      <h3>{t('admin.crm.refunds.paymentsHeading')}</h3>
      {data.refundable.length === 0 ? <p>{t('admin.crm.refunds.noPayments')}</p> : (
        <ul>
          {data.refundable.map((row) => (
            <li key={row.paymentId}>
              {t('admin.crm.refunds.refundableRow', { method: t(`checkout.methods.${row.method}`), amount: amountOf(row.refundableMinor, row.currency) })}
              {row.blockedReason ? <> {t(`admin.crm.refunds.blocked.${row.blockedReason}`)}</> : null}
              {canRequest(row) && asking !== row.paymentId ? (
                <> <button className="link-button" type="button" disabled={busy} onClick={() => setAsking(row.paymentId)}>{t('admin.crm.refunds.request')}</button></>
              ) : null}
              {asking === row.paymentId ? (
                <form className="stack" onSubmit={(e) => void request(e, row)}>
                  <p>{t(row.manual ? 'admin.crm.refunds.manualWarning' : 'admin.crm.refunds.gatewayWarning', { amount: amountOf(row.refundableMinor, row.currency) })}</p>
                  <Field label={t('admin.crm.refunds.reason')} id={`refund-reason-${row.paymentId}`} {...{ name: 'reason' }} minLength={3} maxLength={500} required />
                  <div className="actions">
                    <button className="btn" type="submit" disabled={busy}>{t('admin.crm.refunds.requestConfirm')}</button>
                    <button className="link-button" type="button" onClick={() => setAsking(null)}>{t('admin.crm.refunds.back')}</button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <h3>{t('admin.crm.refunds.refundsHeading')}</h3>
      {data.refunds.length === 0 ? <p>{t('admin.crm.refunds.none')}</p> : (
        <ul>
          {data.refunds.map((r) => {
            const step = manualStep(r);
            return (
              <li key={r.id}>
                {t('admin.crm.refunds.row', { amount: amountOf(r.amountMinor, r.currency), state: t(`admin.crm.refunds.states.${r.status}`), origin: t(`admin.crm.refunds.origins.${r.origin}`), when: formatMoment(r.createdAt) })}
                {r.destinationHint ? <> {t('admin.crm.refunds.hint', { hint: r.destinationHint })}</> : null}
                {isLatePending(r) ? <> {t('admin.crm.refunds.latePending')}</> : null}
                {canResolve(r) ? <> <button className="link-button" type="button" disabled={busy} onClick={() => void run(() => api(`/admin/payments/refunds/${r.id}/resolve`, { method: 'POST', body: { version: r.version } }), 'admin.crm.refunds.resolved')}>{t('admin.crm.refunds.resolve')}</button></> : null}
                {step === 'destination' ? (
                  <form className="stack form" onSubmit={(e) => void destination(e, r)}>
                    <Field label={t('admin.crm.refunds.accountName')} id={`acct-name-${r.id}`} {...{ name: 'accountName' }} autoComplete="off" maxLength={140} required />
                    <div className="field">
                      <label htmlFor={`kind-${r.id}`}>{t('admin.crm.refunds.kind')}</label>
                      <select id={`kind-${r.id}`} name="kind" defaultValue="bank">
                        <option value="bank">{t('admin.crm.refunds.kinds.bank')}</option>
                        <option value="payid">{t('admin.crm.refunds.kinds.payid')}</option>
                      </select>
                    </div>
                    <Field label={t('admin.crm.refunds.bsb')} id={`bsb-${r.id}`} {...{ name: 'bsb' }} inputMode="numeric" autoComplete="off" maxLength={7} />
                    <Field label={t('admin.crm.refunds.accountNumber')} id={`acct-${r.id}`} {...{ name: 'accountNumber' }} inputMode="numeric" autoComplete="off" maxLength={12} />
                    <div className="field">
                      <label htmlFor={`payid-type-${r.id}`}>{t('admin.crm.refunds.payIdType')}</label>
                      <select id={`payid-type-${r.id}`} name="payIdType" defaultValue="email">
                        {['email', 'phone', 'abn', 'org_id'].map((k) => <option key={k} value={k}>{t(`admin.crm.refunds.payIdTypes.${k}`)}</option>)}
                      </select>
                    </div>
                    <Field label={t('admin.crm.refunds.payId')} id={`payid-${r.id}`} {...{ name: 'payId' }} autoComplete="off" maxLength={80} />
                    <p><button className="btn" type="submit" disabled={busy}>{t('admin.crm.refunds.saveDestination')}</button></p>
                  </form>
                ) : null}
                {step === 'transfer' ? (
                  <div className="stack">
                    {shown[r.id] ? <p>{t('admin.crm.refunds.sendTo', { amount: amountOf(r.amountMinor, r.currency), to: shown[r.id]! })}</p> : (
                      <p><button className="link-button" type="button" disabled={busy} onClick={() => void reveal(r)}>{t('admin.crm.refunds.showDestination')}</button></p>
                    )}
                    <form className="stack" onSubmit={(e) => void confirm(e, r)}>
                      <Field label={t('admin.crm.refunds.bankReference')} id={`bank-ref-${r.id}`} {...{ name: 'bankReference' }} autoComplete="off" maxLength={100} required />
                      <div className="actions">
                        <button className="btn" type="submit" disabled={busy}>{t('admin.crm.refunds.confirmSent')}</button>
                        <button className="link-button" type="button" disabled={busy} onClick={() => void run(() => api(`/admin/payments/refunds/${r.id}/cancel-manual`, { method: 'POST', body: { version: r.version } }), 'admin.crm.refunds.withdrawn')}>{t('admin.crm.refunds.withdraw')}</button>
                      </div>
                    </form>
                  </div>
                ) : null}
                {step === 'destination' ? (
                  <p><button className="link-button" type="button" disabled={busy} onClick={() => void run(() => api(`/admin/payments/refunds/${r.id}/cancel-manual`, { method: 'POST', body: { version: r.version } }), 'admin.crm.refunds.withdrawn')}>{t('admin.crm.refunds.withdraw')}</button></p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <h3>{t('admin.crm.refunds.disputesHeading')}</h3>
      {data.disputes.length === 0 ? <p>{t('admin.crm.refunds.noDisputes')}</p> : (
        <ul>
          {data.disputes.map((d) => (
            <li key={d.id}>
              {t('admin.crm.refunds.disputeRow', {
                amount: amountOf(d.amountMinor, d.currency), state: t(`admin.crm.refunds.disputeStates.${d.status}`), reason: t(`admin.crm.refunds.disputeReasons.${d.reasonCode}`),
                due: d.evidenceDueBy ? formatMoment(d.evidenceDueBy) : t('admin.crm.refunds.noDueDate'),
              })}
              {d.fundsWithdrawnAt && !d.fundsReinstatedAt ? <> {t('admin.crm.refunds.fundsTaken')}</> : null}
              {d.fundsReinstatedAt ? <> {t('admin.crm.refunds.fundsBack')}</> : null}
              {' '}
              <button className="link-button" type="button" disabled={busy} onClick={() => void download(d)}>{t('admin.crm.refunds.downloadEvidence')}</button>
              {canMarkEvidence(d) ? <> <button className="link-button" type="button" disabled={busy} onClick={() => void run(() => api(`/admin/payments/disputes/${d.id}/evidence-submitted`, { method: 'POST', body: { version: d.version } }), 'admin.crm.refunds.evidenceMarked')}>{t('admin.crm.refunds.markEvidence')}</button></> : null}
            </li>
          ))}
        </ul>
      )}
      {stepUp.prompt}
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
    </Section>
  );
}
