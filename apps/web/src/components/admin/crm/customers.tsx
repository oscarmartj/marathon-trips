'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { t } from '@/lib/i18n';
import { EntityForm, type FieldDef, Section, type Values, useLoad } from '../catalogue/kit';
import { RecordNotes, crmError, formatMoment, fullName, statusLabel } from './crm-kit';
import { NewQuoteForm } from './quotes';

interface CustomerRow {
  id: string;
  givenName: string;
  familyName: string;
  email: string;
  countryOfResidence: string;
  bookingCount: number;
}

const contactFields = (withEmail: boolean): FieldDef[] => [
  ...(withEmail ? [{ key: 'email', label: t('admin.crm.customer.fields.email'), type: 'text' as const, required: true, maxLength: 254 }] : []),
  { key: 'givenName', label: t('admin.crm.customer.fields.givenName'), type: 'text', required: true, maxLength: 100 },
  { key: 'familyName', label: t('admin.crm.customer.fields.familyName'), type: 'text', required: true, maxLength: 100 },
  { key: 'phone', label: t('admin.crm.customer.fields.phone'), type: 'text', maxLength: 20 },
  { key: 'countryOfResidence', label: t('admin.crm.customer.fields.country'), type: 'text', required: true, maxLength: 2, hint: t('admin.crm.customer.fields.countryHint') },
];

/** Customers: search, the list, and adding one by hand (for someone who rang or emailed). */
export function CustomersPanel() {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({ limit: '25', ...(q.length >= 2 ? { q } : {}), ...(cursors.length ? { cursor: cursors[cursors.length - 1]! } : {}) });
  const list = useLoad<{ items: CustomerRow[]; nextCursor: string | null }>(`/admin/customers?${params.toString()}`);
  const search = (e: FormEvent) => {
    e.preventDefault();
    setQ(draft.trim());
    setCursors([]);
  };
  return (
    <div className="stack">
      <form className="form" role="search" onSubmit={search}>
        <div className="field">
          <label htmlFor="customer-search">{t('admin.crm.customers.searchLabel')}</label>
          <input id="customer-search" type="search" value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} />
        </div>
        <div className="actions">
          <button className="btn" type="submit">{t('admin.crm.inbox.search')}</button>
        </div>
      </form>
      <Status message={list.error} />
      {list.data ? (
        list.data.items.length === 0 ? (
          <p role="status">{t('admin.crm.customers.empty')}</p>
        ) : (
          <table className="table">
            <caption>{t('admin.crm.customers.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.crm.columns.customer')}</th>
                <th scope="col">{t('admin.crm.customer.fields.email')}</th>
                <th scope="col">{t('admin.crm.customer.fields.country')}</th>
                <th scope="col">{t('admin.crm.customers.bookings')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id}>
                  <th scope="row"><Link href={`/admin/customers/${c.id}`}>{fullName(c)}</Link></th>
                  <td>{c.email}</td>
                  <td>{c.countryOfResidence}</td>
                  <td>{c.bookingCount}</td>
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
      <Section id="new-customer" title={t('admin.crm.customers.add')}>
        <p>{t('admin.crm.customers.addHelp')}</p>
        <EntityForm
          id="new-customer"
          fields={contactFields(true)}
          initial={{ email: '', givenName: '', familyName: '', phone: '', countryOfResidence: 'AU' }}
          submit={t('admin.crm.customers.addSubmit')}
          resetOnSuccess
          onSubmit={async (v: Values) => {
            const r = await api<{ id: string }>('/admin/customers', {
              method: 'POST',
              body: { email: String(v.email).trim(), givenName: String(v.givenName).trim(), familyName: String(v.familyName).trim(), countryOfResidence: String(v.countryOfResidence).trim(), ...(String(v.phone).trim() ? { phone: String(v.phone).trim() } : {}) },
            });
            if (r.status === 201 && typeof r.body.id === 'string') {
              window.location.assign(`/admin/customers/${r.body.id}`);
              return { ok: true as const };
            }
            return { ok: false as const, message: crmError(r) };
          }}
        />
      </Section>
    </div>
  );
}

interface CustomerView {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
  phone: string | null;
  countryOfResidence: string;
  source: string;
  signedUp: boolean;
  version: number;
  createdAt: string;
  bookings: Array<{ id: string; reference: string; status: string; currency: string; totalMinor: string; requestedAt: string; package: { name: Record<string, string> } }>;
  quotes: Array<{ id: string; reference: string; status: string; expiresAt: string | null; currency: string; totalMinor: string; package: { name: Record<string, string> } }>;
  emails: Array<{ id: string; templateKey: string; subject: string | null; status: string; sentAt: string | null; createdAt: string }>;
  alerts: Array<{ id: string; status: string; confirmedAt: string | null; race: { name: Record<string, string> } | null }>;
}

/** The customer record (task 2.5): contact, then the history of bookings, quotes, emails and alerts, notes, and a new quote. */
export function CustomerDetail({ id }: { id: string }) {
  const { data: c, error, reload } = useLoad<CustomerView>(`/admin/customers/${id}`);
  if (!c) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  return (
    <div className="stack">
      <Section id="customer-contact" title={t('admin.crm.customer.contact')}>
        <p>{c.signedUp ? t('admin.crm.customer.signedUp') : t('admin.crm.customer.notSignedUp')}</p>
        <p>{t('admin.crm.customer.emailLine', { email: c.email })}</p>
        <EntityForm
          id="customer-edit"
          fields={contactFields(false)}
          initial={{ givenName: c.givenName, familyName: c.familyName, phone: c.phone ?? '', countryOfResidence: c.countryOfResidence }}
          submit={t('admin.crm.customer.save')}
          onSubmit={async (v: Values) => {
            const r = await api(`/admin/customers/${id}`, {
              method: 'PATCH',
              body: { version: c.version, givenName: String(v.givenName).trim(), familyName: String(v.familyName).trim(), countryOfResidence: String(v.countryOfResidence).trim(), phone: String(v.phone).trim() || null },
            });
            if (r.status === 200) {
              await reload();
              return { ok: true as const, message: t('admin.catalogue.common.saved') };
            }
            return { ok: false as const, message: crmError(r) };
          }}
        />
      </Section>
      <Section id="customer-bookings" title={t('admin.crm.customer.bookings')}>
        {c.bookings.length === 0 ? <p>{t('admin.crm.customer.noBookings')}</p> : (
          <ul className="stack">
            {c.bookings.map((b) => (
              <li key={b.id}>
                <Link href={`/admin/bookings/${b.id}`}>{b.reference}</Link> {t('admin.crm.customer.rowLine', { name: localisedText(b.package.name), status: statusLabel('booking', b.status), total: formatMoney(b.totalMinor, b.currency) })}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="customer-quotes" title={t('admin.crm.customer.quotes')}>
        {c.quotes.length === 0 ? <p>{t('admin.crm.customer.noQuotes')}</p> : (
          <ul className="stack">
            {c.quotes.map((q) => (
              <li key={q.id}>
                <Link href={`/admin/quotes/${q.id}`}>{q.reference}</Link> {t('admin.crm.customer.rowLine', { name: localisedText(q.package.name), status: statusLabel('quote', q.status), total: formatMoney(q.totalMinor, q.currency) })}
              </li>
            ))}
          </ul>
        )}
        <NewQuoteForm customerId={id} />
      </Section>
      <Section id="customer-emails" title={t('admin.crm.customer.emails')}>
        {c.emails.length === 0 ? <p>{t('admin.crm.customer.noEmails')}</p> : (
          <ul className="stack">
            {c.emails.map((m) => (
              <li key={m.id}>{t('admin.crm.customer.emailRow', { subject: m.subject ?? m.templateKey, status: m.status, when: formatMoment(m.sentAt ?? m.createdAt) })}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="customer-alerts" title={t('admin.crm.customer.alerts')}>
        {c.alerts.length === 0 ? <p>{t('admin.crm.customer.noAlerts')}</p> : (
          <ul className="stack">
            {c.alerts.map((a) => (
              <li key={a.id}>{t('admin.crm.customer.alertRow', { race: a.race ? localisedText(a.race.name) : t('admin.crm.customer.anyRace'), status: a.status })}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="customer-notes" title={t('admin.crm.notes.title')}>
        <RecordNotes entityType="Customer" id={id} />
      </Section>
    </div>
  );
}
