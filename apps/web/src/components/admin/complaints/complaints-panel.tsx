'use client';

import Link from 'next/link';
import { COMPLAINT_ATTENTION, COMPLAINT_CATEGORIES, COMPLAINT_CHANNELS, COMPLAINT_STATUSES } from '@mt/shared';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api-client';
import { emptyFilters, createBody, listParams, type ListFilters } from '@/lib/complaints-panel';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { EntityForm, type FieldDef, Section, useLoad } from '../catalogue/kit';
import { DeadlineBadge, type Deadlines, SOON, complaintError } from './complaints-kit';

interface ComplaintRow {
  id: string;
  reference: string;
  summary: string;
  complainantName: string;
  category: string;
  status: string;
  receivedDate: string;
  owner: { id: string; email: string | null } | null;
  deadlines: Deadlines;
}
interface Summary {
  open: number;
  acknowledgeOverdue: number;
  resolveOverdue: number;
  dueSoon: number;
  unowned: number;
}
interface ListResult {
  items: ComplaintRow[];
  total: number;
  page: number;
  pageSize: number;
}

const options = (group: string, values: readonly string[]) => values.map((v) => ({ value: v, label: t(`admin.complaints.${group}.${v}`) }));

export const complaintFields = (owners: ReadonlyArray<{ id: string; email: string }>, withLinks: boolean): FieldDef[] => [
  { key: 'summary', label: t('admin.complaints.fields.summary'), type: 'text', required: true, maxLength: 200 },
  { key: 'description', label: t('admin.complaints.fields.description'), type: 'textarea', required: true, maxLength: 4000 },
  { key: 'channel', label: t('admin.complaints.fields.channel'), type: 'select', required: true, options: options('channels', COMPLAINT_CHANNELS) },
  { key: 'category', label: t('admin.complaints.fields.category'), type: 'select', required: true, options: options('categories', COMPLAINT_CATEGORIES) },
  { key: 'complainantName', label: t('admin.complaints.fields.complainantName'), type: 'text', maxLength: 200, hint: withLinks ? t('admin.complaints.fields.complainantNameHint') : undefined },
  { key: 'complainantEmail', label: t('admin.complaints.fields.complainantEmail'), type: 'text', maxLength: 254 },
  ...(withLinks
    ? ([
        { key: 'receivedDate', label: t('admin.complaints.fields.receivedDate'), type: 'date', hint: t('admin.complaints.fields.receivedDateHint') },
        { key: 'customerId', label: t('admin.complaints.fields.customerId'), type: 'text', maxLength: 40 },
        { key: 'bookingId', label: t('admin.complaints.fields.bookingId'), type: 'text', maxLength: 40, hint: t('admin.complaints.fields.linkHint') },
      ] satisfies FieldDef[])
    : []),
  { key: 'ownerId', label: t('admin.complaints.fields.ownerId'), type: 'select', options: [{ value: '', label: t('admin.complaints.fields.noOwner') }, ...owners.map((o) => ({ value: o.id, label: o.email }))] },
];

/** The register: where things stand, filters, the list (most urgent first) and a form to log a complaint. */
export function ComplaintsPanel() {
  const [filters, setFilters] = useState<ListFilters>(emptyFilters);
  const [draft, setDraft] = useState<ListFilters>(emptyFilters);
  const summary = useLoad<Summary>('/admin/complaints/summary');
  const list = useLoad<ListResult>(`/admin/complaints?${listParams(filters)}`);
  const owners = useLoad<{ items: Array<{ id: string; email: string }> }>('/admin/complaints/owners');
  const apply = (next: ListFilters) => {
    setFilters(next);
    setDraft(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    apply({ ...draft, page: 1 });
  };
  const tiles: Array<{ key: keyof Summary; apply: Partial<ListFilters> }> = [
    { key: 'open', apply: { status: 'open', attention: '' } },
    { key: 'acknowledgeOverdue', apply: { status: 'open', attention: 'acknowledge_overdue' } },
    { key: 'resolveOverdue', apply: { status: 'open', attention: 'resolve_overdue' } },
    { key: 'dueSoon', apply: { status: 'open', attention: 'due_soon' } },
    { key: 'unowned', apply: { status: 'open', attention: '' } },
  ];
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div className="stack">
      <Section id="complaints-summary" title={t('admin.complaints.summary.title')}>
        <Status message={summary.error} />
        {summary.data ? (
          <ul className="stack">
            {tiles.map((tile) => (
              <li key={tile.key}>
                <strong>{summary.data![tile.key]}</strong>{' '}
                {t(`admin.complaints.summary.${tile.key}`, { days: SOON })}
                {tile.key !== 'unowned' ? (
                  <>
                    {' '}
                    <button type="button" className="link-button" onClick={() => apply({ ...emptyFilters, ...tile.apply, status: 'open' })}>
                      {t('admin.complaints.summary.show')}
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
      </Section>

      <Section id="complaints-list" title={t('admin.complaints.list.title')}>
        <form className="form" role="search" aria-label={t('admin.complaints.filters.label')} onSubmit={submit}>
          <div className="field">
            <label htmlFor="complaint-search">{t('admin.complaints.filters.search')}</label>
            <input id="complaint-search" type="search" maxLength={100} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="complaint-status">{t('admin.complaints.filters.status')}</label>
            <select id="complaint-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as ListFilters['status'] })}>
              <option value="">{t('admin.complaints.filters.allStatuses')}</option>
              <option value="open">{t('admin.complaints.filters.open')}</option>
              {COMPLAINT_STATUSES.map((s) => (
                <option key={s} value={s}>{t(`admin.complaints.statuses.${s}`)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="complaint-attention">{t('admin.complaints.filters.attention')}</label>
            <select id="complaint-attention" value={draft.attention} onChange={(e) => setDraft({ ...draft, attention: e.target.value as ListFilters['attention'] })}>
              <option value="">{t('admin.complaints.filters.anyAttention')}</option>
              {COMPLAINT_ATTENTION.map((a) => (
                <option key={a} value={a}>{t(`admin.complaints.filters.attentionValues.${a}`, { days: SOON })}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="complaint-category">{t('admin.complaints.filters.category')}</label>
            <select id="complaint-category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as ListFilters['category'] })}>
              <option value="">{t('admin.complaints.filters.anyCategory')}</option>
              {COMPLAINT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`admin.complaints.categories.${c}`)}</option>
              ))}
            </select>
          </div>
          <div className="actions">
            <button className="btn" type="submit">{t('admin.complaints.filters.apply')}</button>
          </div>
        </form>
        <Status message={list.error} />
        {list.data ? (
          list.data.items.length === 0 ? (
            <p role="status">{t('admin.complaints.list.empty')}</p>
          ) : (
            <>
              <p role="status">{t('admin.complaints.list.count', { count: list.data.total })}</p>
              <table className="table">
                <caption>{t('admin.complaints.list.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.complaints.list.reference')}</th>
                    <th scope="col">{t('admin.complaints.list.titleColumn')}</th>
                    <th scope="col">{t('admin.complaints.list.category')}</th>
                    <th scope="col">{t('admin.complaints.list.status')}</th>
                    <th scope="col">{t('admin.complaints.list.acknowledge')}</th>
                    <th scope="col">{t('admin.complaints.list.resolve')}</th>
                    <th scope="col">{t('admin.complaints.list.owner')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((c) => (
                    <tr key={c.id}>
                      <th scope="row"><Link href={`/admin/complaints/${c.id}`}>{c.reference}</Link></th>
                      <td>{c.summary}</td>
                      <td>{t(`admin.complaints.categories.${c.category}`)}</td>
                      <td>{t(`admin.complaints.statuses.${c.status}`)}</td>
                      <td><DeadlineBadge m={c.deadlines.acknowledge} /></td>
                      <td><DeadlineBadge m={c.deadlines.resolve} /></td>
                      <td>{c.owner ? (c.owner.email ?? c.owner.id) : t('admin.complaints.list.noOwner')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="actions">
                <button type="button" className="btn" disabled={filters.page <= 1} onClick={() => apply({ ...filters, page: filters.page - 1 })}>{t('admin.complaints.list.previous')}</button>
                <button type="button" className="btn" disabled={filters.page >= pages} onClick={() => apply({ ...filters, page: filters.page + 1 })}>{t('admin.complaints.list.next')}</button>
              </p>
            </>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
      </Section>

      <Section id="complaints-new" title={t('admin.complaints.new.title')}>
        <p>{t('admin.complaints.new.intro')}</p>
        <EntityForm
          id="new-complaint"
          fields={[...complaintFields(owners.data?.items ?? [], true), { key: 'reason', label: t('admin.complaints.fields.reason'), type: 'text', maxLength: 500 }, { key: 'acknowledgeDueDate', label: t('admin.complaints.fields.acknowledgeDueDate'), type: 'date' }, { key: 'resolveDueDate', label: t('admin.complaints.fields.resolveDueDate'), type: 'date', hint: t('admin.complaints.fields.deadlineHint') }]}
          initial={{ summary: '', description: '', channel: 'email', category: 'service', complainantName: '', complainantEmail: '', receivedDate: '', customerId: '', bookingId: '', ownerId: '', reason: '', acknowledgeDueDate: '', resolveDueDate: '' }}
          submit={t('admin.complaints.new.submit')}
          resetOnSuccess
          onSubmit={async (v) => {
            const s = (k: string) => String(v[k] ?? '');
            const body = createBody({ complainantName: s('complainantName'), complainantEmail: s('complainantEmail'), channel: s('channel'), category: s('category'), summary: s('summary'), description: s('description'), receivedDate: s('receivedDate'), customerId: s('customerId'), bookingId: s('bookingId'), ownerId: s('ownerId'), reason: s('reason') });
            if (s('acknowledgeDueDate')) body.acknowledgeDueDate = s('acknowledgeDueDate');
            if (s('resolveDueDate')) body.resolveDueDate = s('resolveDueDate');
            const r = await api('/admin/complaints', { method: 'POST', body });
            if (r.status !== 201) return { ok: false, message: complaintError(r) };
            void list.reload();
            void summary.reload();
            return { ok: true, message: t('admin.complaints.new.logged') };
          }}
        />
      </Section>
    </div>
  );
}
