'use client';

import { useEffect, useState } from 'react';
import type { DashboardView } from '@mt/shared';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { bookingPath, editionPath, formatInstant, presentSections, racePath, tripLine } from '@/lib/dashboard-panel';
import { formatMinor } from '@/lib/supplier-format';
import { Status } from '../../auth/field';
import { Section, catalogueError, formatDay } from '../catalogue/kit';

type Sections = DashboardView['sections'];

function NewRequests({ data }: { data: NonNullable<Sections['newRequests']> }) {
  return (
    <Section id="dash-requests" title={t('admin.dashboard.requests.title')}>
      <p>{t('admin.dashboard.requests.summary', { count: data.total })}</p>
      {data.items.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table">
            <caption>{t('admin.dashboard.requests.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.dashboard.requests.reference')}</th>
                <th scope="col">{t('admin.dashboard.requests.trip')}</th>
                <th scope="col">{t('admin.dashboard.requests.requested')}</th>
                <th scope="col">{t('admin.dashboard.requests.expires')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <th scope="row"><a href={bookingPath(i.id)}>{i.reference}</a></th>
                  <td>{tripLine(i.raceName, i.year)}: {i.packageName}</td>
                  <td>{formatInstant(i.requestedAt)}</td>
                  <td>{formatInstant(i.requestExpiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p><a href="/admin/bookings">{t('admin.dashboard.requests.all')}</a></p>
    </Section>
  );
}

function PendingPayments({ data }: { data: NonNullable<Sections['pendingPayments']> }) {
  return (
    <Section id="dash-payments" title={t('admin.dashboard.payments.title')}>
      <p>{t('admin.dashboard.payments.summary', { overdue: data.overdue, dueSoon: data.dueSoon, days: data.horizonDays })}</p>
      {data.truncated ? <p className="field__hint">{t('admin.dashboard.payments.truncated')}</p> : null}
      {data.items.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table">
            <caption>{t('admin.dashboard.payments.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.dashboard.payments.reference')}</th>
                <th scope="col">{t('admin.dashboard.payments.what')}</th>
                <th scope="col">{t('admin.dashboard.payments.due')}</th>
                <th scope="col">{t('admin.dashboard.payments.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={`${i.bookingId}-${i.sequence}`}>
                  <th scope="row"><a href={bookingPath(i.bookingId)}>{i.reference}</a></th>
                  <td>{t(`admin.dashboard.payments.kinds.${i.kind}`)}</td>
                  <td>
                    {formatDay(i.dueDate)}
                    {i.overdue ? <>{' '}<span className="badge badge--warn">{t('admin.dashboard.payments.overdue')}</span></> : null}
                  </td>
                  <td>{formatMinor(i.amountDueMinor, i.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Tasks({ data }: { data: NonNullable<Sections['tasks']> }) {
  return (
    <Section id="dash-tasks" title={t('admin.dashboard.tasks.title')}>
      <p>{t('admin.dashboard.tasks.summary', { overdue: data.overdue, dueSoon: data.dueSoon })}</p>
      {data.items.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table">
            <caption>{t('admin.dashboard.tasks.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.dashboard.tasks.task')}</th>
                <th scope="col">{t('admin.dashboard.tasks.due')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.title}</th>
                  <td>
                    {formatInstant(i.dueAt)}
                    {i.overdue ? <>{' '}<span className="badge badge--warn">{t('admin.dashboard.tasks.overdue')}</span></> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p><a href="/admin/tasks">{t('admin.dashboard.tasks.all')}</a></p>
    </Section>
  );
}

function Stock({ data }: { data: NonNullable<Sections['stock']> }) {
  return (
    <Section id="dash-stock" title={t('admin.dashboard.stock.title')}>
      <p>{t('admin.dashboard.stock.summary', { count: data.lowCount })}</p>
      {data.items.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table">
            <caption>{t('admin.dashboard.stock.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.dashboard.stock.pool')}</th>
                <th scope="col">{t('admin.dashboard.stock.trip')}</th>
                <th scope="col">{t('admin.dashboard.stock.left')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{t(`admin.dashboard.stock.kinds.${i.kind}`)}: {i.label}</th>
                  <td><a href={editionPath(i.editionId)}>{tripLine(i.raceName, i.year)}</a></td>
                  <td>
                    {t('admin.dashboard.stock.ofCapacity', { remaining: i.remaining, capacity: i.capacity })}
                    {i.remaining <= 0 ? <>{' '}<span className="badge badge--warn">{t('admin.dashboard.stock.soldOut')}</span></> : i.lowStock ? <>{' '}<span className="badge badge--warn">{t('admin.dashboard.stock.low')}</span></> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Subscribers({ data }: { data: NonNullable<Sections['subscribers']> }) {
  return (
    <Section id="dash-subscribers" title={t('admin.dashboard.subscribers.title')}>
      <p>{t('admin.dashboard.subscribers.summary', { confirmed: data.confirmed, pending: data.pending })}</p>
      {data.races.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table">
            <caption>{t('admin.dashboard.subscribers.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.dashboard.subscribers.race')}</th>
                <th scope="col">{t('admin.dashboard.subscribers.confirmed')}</th>
                <th scope="col">{t('admin.dashboard.subscribers.pending')}</th>
              </tr>
            </thead>
            <tbody>
              {data.races.map((r) => (
                <tr key={r.raceId}>
                  <th scope="row"><a href={racePath(r.raceId)}>{r.raceName}</a></th>
                  <td>{r.confirmed}</td>
                  <td>{r.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** The sections the API sent, in order. Nothing is worked out here: counts, amounts and dates are the API's. */
export function DashboardSections({ view }: { view: DashboardView }) {
  const keys = presentSections(view);
  if (keys.length === 0) return <p className="notice" role="note">{t('admin.dashboard.nothingToShow')}</p>;
  const s = view.sections;
  return (
    <div className="stack" data-testid="dashboard">
      {keys.map((k) => {
        switch (k) {
          case 'newRequests': return <NewRequests key={k} data={s.newRequests!} />;
          case 'pendingPayments': return <PendingPayments key={k} data={s.pendingPayments!} />;
          case 'tasks': return <Tasks key={k} data={s.tasks!} />;
          case 'stock': return <Stock key={k} data={s.stock!} />;
          case 'subscribers': return <Subscribers key={k} data={s.subscribers!} />;
        }
      })}
    </div>
  );
}

/** The staff start page (task 5.6). Someone without the permission gets the friendly empty state, not an error. */
export function DashboardPanel() {
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api<DashboardView>('/admin/dashboard').then((r) => {
      if (!current) return;
      if (r.status === 200) setView(r.body as unknown as DashboardView);
      else if (r.status === 403) setView({ today: '', generatedAt: '', sections: {} });
      else setError(catalogueError(r));
    });
    return () => { current = false; };
  }, []);
  if (error) return <Status message={error} />;
  if (!view) return <p role="status">{t('admin.common.loading')}</p>;
  return <DashboardSections view={view} />;
}
