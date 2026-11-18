'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { BOOKING_STATUSES } from '@mt/shared';
import { Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { t } from '@/lib/i18n';
import { Section, formatDay, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';
import { RecordNotes, crmError, formatMoment, fullName, statusLabel } from './crm-kit';
import { PaymentLinksPanel } from './payment-links';
import { AmendmentPanel, type AmendmentRow } from './amendments';
import type { ConfigurationView } from '@/lib/amendments';

interface Row {
  id: string;
  reference: string;
  status: string;
  currency: string;
  totalMinor: string;
  requestedAt: string;
  requestExpiresAt: string | null;
  customer: { id: string; givenName: string; familyName: string; email: string };
}

/** The inbox of booking requests: a tab per state with its count, a search box, and the rows. */
export function BookingsInbox() {
  const [status, setStatus] = useState<string>('requested');
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const summary = useLoad<{ counts: Record<string, number> }>('/admin/bookings/summary');
  const params = new URLSearchParams({ limit: '25', ...(status ? { status } : {}), ...(q.length >= 2 ? { q } : {}), ...(cursors.length ? { cursor: cursors[cursors.length - 1]! } : {}) });
  const list = useLoad<{ items: Row[]; nextCursor: string | null }>(`/admin/bookings?${params.toString()}`);
  const counts = summary.data?.counts ?? {};
  const pick = (s: string) => {
    setStatus(s);
    setCursors([]);
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    setQ(draft.trim());
    setCursors([]);
  };
  const tabs = ['', ...BOOKING_STATUSES.filter((s) => (counts[s] ?? 0) > 0 || s === 'requested')];
  return (
    <div className="stack">
      <form className="form" role="search" onSubmit={search}>
        <div className="field">
          <label htmlFor="inbox-search">{t('admin.crm.inbox.searchLabel')}</label>
          <input id="inbox-search" type="search" value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} aria-describedby="inbox-search-hint" />
          <p id="inbox-search-hint" className="field__hint">{t('admin.crm.inbox.searchHint')}</p>
        </div>
        <div className="actions">
          <button className="btn" type="submit">{t('admin.crm.inbox.search')}</button>
        </div>
      </form>
      <div role="group" aria-label={t('admin.crm.inbox.tabsLabel')} className="actions">
        {tabs.map((s) => (
          <button key={s || 'all'} type="button" className={status === s ? 'btn' : 'link-button'} aria-pressed={status === s} onClick={() => pick(s)}>
            {s ? t('admin.crm.inbox.tab', { status: statusLabel('booking', s), count: String(counts[s] ?? 0) }) : t('admin.crm.inbox.tabAll')}
          </button>
        ))}
      </div>
      <Status message={summary.error ?? list.error} />
      {list.data ? (
        list.data.items.length === 0 ? (
          <p role="status">{t('admin.crm.inbox.empty')}</p>
        ) : (
          <table className="table">
            <caption>{t('admin.crm.inbox.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.crm.columns.reference')}</th>
                <th scope="col">{t('admin.crm.columns.customer')}</th>
                <th scope="col">{t('admin.crm.columns.status')}</th>
                <th scope="col">{t('admin.crm.columns.total')}</th>
                <th scope="col">{t('admin.crm.columns.requested')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((b) => (
                <tr key={b.id}>
                  <th scope="row"><Link href={`/admin/bookings/${b.id}`}>{b.reference}</Link></th>
                  <td>{fullName(b.customer)}</td>
                  <td>{statusLabel('booking', b.status)}</td>
                  <td>{formatMoney(b.totalMinor, b.currency)}</td>
                  <td>{formatMoment(b.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <p role="status">{t('admin.common.loading')}</p>
      )}
      <div className="actions">
        <button type="button" className="link-button" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>{t('admin.crm.inbox.previous')}</button>
        <button type="button" className="link-button" disabled={!list.data?.nextCursor} onClick={() => list.data?.nextCursor && setCursors((c) => [...c, list.data!.nextCursor!])}>{t('admin.crm.inbox.next')}</button>
      </div>
    </div>
  );
}

interface BookingView {
  id: string;
  reference: string;
  status: string;
  version: number;
  currency: string;
  totalMinor: string;
  depositMinor: string;
  departureDate: string;
  returnDate: string;
  balanceDueDate: string;
  requestedAt: string;
  requestExpiresAt: string | null;
  customer: { id: string; email: string; givenName: string; familyName: string; phone: string | null; countryOfResidence: string };
  travellers: Array<{ id: string; slot: number; participationType: string; isLead: boolean; removedInVersion: number | null }>;
  rooms: Array<{ id: string; occupancy: number }>;
  packageId: string;
  currentSnapshotVersion: number;
  snapshots: Array<{ version: number; configuration: ConfigurationView }>;
  amendments: AmendmentRow[];
}

/** One booking: what was asked and priced, the actions the state machine allows, and the team's notes. */
export function BookingDetail({ id }: { id: string }) {
  const { data: b, error, reload } = useLoad<BookingView>(`/admin/bookings/${id}`);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const stepUp = useStepUp();
  if (!b) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;

  async function act(event: 'approve' | 'decline' | 'cancel') {
    if (!b) return;
    if (event !== 'approve' && !reason.trim()) {
      setMessage({ text: t('admin.crm.booking.reasonRequired'), tone: 'error' });
      return;
    }
    const r = await stepUp.run(() => api(`/admin/bookings/${id}/${event}`, { method: 'POST', body: { version: b.version, ...(reason.trim() ? { reason: reason.trim() } : {}) } }));
    if (r.status === 200) {
      setReason('');
      setMessage({ text: t(`admin.crm.booking.done.${event}`), tone: 'info' });
      await reload();
    } else setMessage({ text: crmError(r), tone: 'error' });
  }

  const open = b.status === 'requested';
  const approved = b.status === 'approved';
  return (
    <div className="stack">
      <Section id="booking-summary" title={t('admin.crm.booking.summary', { reference: b.reference })}>
        <dl>
          <dt>{t('admin.crm.columns.status')}</dt>
          <dd>{statusLabel('booking', b.status)}</dd>
          <dt>{t('admin.crm.columns.customer')}</dt>
          <dd><Link href={`/admin/customers/${b.customer.id}`}>{fullName(b.customer)}</Link> ({b.customer.email})</dd>
          <dt>{t('admin.crm.booking.dates')}</dt>
          <dd>{t('admin.crm.booking.dateRange', { from: formatDay(b.departureDate), to: formatDay(b.returnDate) })}</dd>
          <dt>{t('admin.crm.columns.total')}</dt>
          <dd>{formatMoney(b.totalMinor, b.currency)}</dd>
          {/* After a change the deposit asked is the payment plan's, not the new snapshot's (task 6.3, review m4). */}
          {(b.amendments ?? []).length === 0 ? (
            <>
              <dt>{t('admin.crm.booking.deposit')}</dt>
              <dd>{t('admin.crm.booking.depositLine', { amount: formatMoney(b.depositMinor, b.currency), date: formatDay(b.balanceDueDate) })}</dd>
            </>
          ) : null}
          <dt>{t('admin.crm.columns.requested')}</dt>
          <dd>{formatMoment(b.requestedAt)}</dd>
          {b.requestExpiresAt ? (
            <>
              <dt>{t('admin.crm.booking.heldUntil')}</dt>
              <dd>{formatMoment(b.requestExpiresAt)}</dd>
            </>
          ) : null}
          <dt>{t('admin.crm.booking.travellers')}</dt>
          <dd>{t('admin.crm.booking.travellerCount', { count: String(b.travellers.filter((x) => x.removedInVersion === null).length), rooms: String(b.rooms.length) })}</dd>
        </dl>
      </Section>
      {open || approved ? (
        <Section id="booking-actions" title={t('admin.crm.booking.actions')}>
          <div className="field">
            <label htmlFor="booking-reason">{t('admin.crm.booking.reason')}</label>
            <textarea id="booking-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="booking-reason-hint" />
            <p id="booking-reason-hint" className="field__hint">{t('admin.crm.booking.reasonHint')}</p>
          </div>
          <div className="actions">
            {open ? <button className="btn" type="button" onClick={() => void act('approve')}>{t('admin.crm.booking.approve')}</button> : null}
            {open ? <button className="link-button" type="button" onClick={() => void act('decline')}>{t('admin.crm.booking.decline')}</button> : null}
            {open || approved ? <button className="link-button" type="button" onClick={() => void act('cancel')}>{t('admin.crm.booking.cancel')}</button> : null}
          </div>
          {stepUp.prompt}
        </Section>
      ) : null}
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      <PaymentLinksPanel bookingId={id} status={b.status} />
      {b.snapshots ? (
        <AmendmentPanel
          bookingId={id} packageId={b.packageId} status={b.status} version={b.currentSnapshotVersion} currency={b.currency} rows={b.amendments ?? []}
          configuration={b.snapshots.find((s) => s.version === b.currentSnapshotVersion)!.configuration} onChanged={reload}
        />
      ) : null}
      <Section id="booking-notes" title={t('admin.crm.notes.title')}>
        <RecordNotes entityType="Booking" id={id} />
      </Section>
    </div>
  );
}
