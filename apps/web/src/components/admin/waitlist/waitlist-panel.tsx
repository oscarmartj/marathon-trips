'use client';

import { WAITLIST_STATUSES } from '@mt/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';

interface Row {
  id: string;
  position: number;
  status: string;
  reason: string;
  packageId: string;
  travellers: number;
  countryOfResidence: string;
  email: string;
  createdAt: string;
  offerExpiresAt: string | null;
  customer: { id: string; givenName: string; familyName: string };
}
interface Page {
  items: Row[];
  nextCursor: string | null;
}

const when = (iso: string): string => new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(new Date(iso));

/** Who is waiting for each package, in the order they joined, and which offers are open. Read only. */
export function WaitlistPanel() {
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (filter: string, after: string | null) => {
    setLoading(true);
    const q = new URLSearchParams({ limit: '50' });
    if (filter) q.set('status', filter);
    if (after) q.set('cursor', after);
    try {
      const r = await api<Page>(`/admin/waitlist?${q.toString()}`);
      if (r.status !== 200) {
        setError(t('admin.waitlist.error'));
        return;
      }
      setError(null);
      setRows((prev) => (after ? [...prev, ...r.body.items] : r.body.items));
      setCursor(r.body.nextCursor);
    } catch {
      setError(t('admin.waitlist.error'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(applied, null);
  }, [applied, load]);

  return (
    <div className="stack">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(status);
        }}
      >
        <label htmlFor="waitlist-status">{t('admin.waitlist.filters.status')}</label>
        <select id="waitlist-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('admin.waitlist.filters.all')}</option>
          {WAITLIST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`admin.waitlist.statuses.${s}`)}
            </option>
          ))}
        </select>{' '}
        <button className="btn" type="submit">{t('admin.waitlist.filters.apply')}</button>
      </form>
      <Status message={error} />
      {loading && rows.length === 0 ? <p role="status">{t('admin.waitlist.loading')}</p> : null}
      {!loading && rows.length === 0 && !error ? <p>{t('admin.waitlist.empty')}</p> : null}
      {rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              {(['position', 'customer', 'email', 'country', 'travellers', 'reason', 'status', 'offerEnds', 'joined'] as const).map((c) => (
                <th key={c} scope="col">{t(`admin.waitlist.columns.${c}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.position}</td>
                <td>{r.customer.givenName} {r.customer.familyName}</td>
                <td>{r.email}</td>
                <td>{r.countryOfResidence}</td>
                <td>{r.travellers}</td>
                <td>{t(`admin.waitlist.reasons.${r.reason}`)}</td>
                <td>{t(`admin.waitlist.statuses.${r.status}`)}</td>
                <td>{r.offerExpiresAt ? when(r.offerExpiresAt) : ''}</td>
                <td>{when(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {cursor ? (
        <p>
          <button className="btn btn-secondary" type="button" disabled={loading} onClick={() => void load(applied, cursor)}>
            {t('admin.waitlist.loadMore')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
