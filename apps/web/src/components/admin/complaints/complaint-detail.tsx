'use client';

import Link from 'next/link';
import { COMPLAINT_OUTCOMES, type ComplaintStatus } from '@mt/shared';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { historyKey, isReopen, nextStatuses, transitionBody } from '@/lib/complaints-panel';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { EntityForm, Section, formatDay, useLoad } from '../catalogue/kit';
import { RecordNotes, formatMoment, fullName } from '../crm/crm-kit';
import { DeadlineBadge, type Deadlines, complaintError } from './complaints-kit';
import { complaintFields } from './complaints-panel';

interface Complaint {
  id: string;
  reference: string;
  status: ComplaintStatus;
  category: string;
  channel: string;
  summary: string;
  description: string;
  complainantName: string;
  complainantEmail: string | null;
  receivedDate: string;
  acknowledgeDueDate: string;
  resolveDueDate: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  withdrawnAt: string | null;
  outcome: string | null;
  resolutionSummary: string | null;
  ownerId: string | null;
  owner: { id: string; email: string | null } | null;
  version: number;
  deadlines: Deadlines;
  customer: { id: string; givenName: string; familyName: string; email: string } | null;
  booking: { id: string; reference: string; status: string } | null;
}
/** Written as an interface because the copy test reads an arrow followed by text and a generic as page text. */
interface PatchBody {
  [key: string]: unknown;
}
interface HistoryEntry {
  id: string;
  occurredAt: string;
  action: string;
  reason: string | null;
}

function actionLabel(action: string): string {
  const key = historyKey(action);
  if (key) {
    try {
      return t(`admin.complaints.history.actions.${key}`);
    } catch {
      /* falls through to the raw action */
    }
  }
  return action;
}

/** The ways to move a complaint on: one button each, and for resolving a form for the outcome and the written resolution. */
function StatusActions({ c, done }: { c: Complaint; done: () => void }) {
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<string>(COMPLAINT_OUTCOMES[0]);
  const [resolution, setResolution] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const next = nextStatuses(c.status);

  async function move(status: ComplaintStatus) {
    const r = await api(`/admin/complaints/${c.id}/status`, { method: 'POST', body: transitionBody(status, c.version, { outcome, resolutionSummary: resolution, reason }) });
    if (r.status === 200) {
      setMessage({ text: t('admin.complaints.status.moved'), tone: 'info' });
      setReason('');
      setResolution('');
      done();
    } else setMessage({ text: complaintError(r), tone: 'error' });
  }

  if (next.length === 0) return <p>{t('admin.complaints.status.none')}</p>;
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="complaint-status-reason">{t('admin.complaints.status.reason')}</label>
        <input id="complaint-status-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {next.includes('resolved') ? (
        <form
          className="form stack"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void move('resolved');
          }}
        >
          <div className="field">
            <label htmlFor="complaint-outcome">{t('admin.complaints.status.outcome')}</label>
            <select id="complaint-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {COMPLAINT_OUTCOMES.map((o) => (
                <option key={o} value={o}>{t(`admin.complaints.outcomes.${o}`)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="complaint-resolution">{t('admin.complaints.status.resolution')}</label>
            <textarea id="complaint-resolution" rows={4} maxLength={4000} required value={resolution} aria-describedby="complaint-resolution-hint" onChange={(e) => setResolution(e.target.value)} />
            <p id="complaint-resolution-hint" className="field__hint">{t('admin.complaints.status.resolutionHint')}</p>
          </div>
          <div className="actions">
            <button className="btn" type="submit">{t('admin.complaints.status.to.resolved')}</button>
          </div>
        </form>
      ) : null}
      <p className="actions">
        {next.filter((s) => s !== 'resolved').map((s) => (
          <button key={s} type="button" className={s === 'withdrawn' ? 'link-button' : 'btn'} onClick={() => void move(s)}>
            {isReopen(c.status, s) ? t('admin.complaints.status.reopen') : t(`admin.complaints.status.to.${s}`)}
          </button>
        ))}
      </p>
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
    </div>
  );
}

/** One complaint: deadlines, the move-on actions, what was decided, the details, notes and the history. */
export function ComplaintDetail({ id }: { id: string }) {
  const complaint = useLoad<Complaint>(`/admin/complaints/${id}`);
  const owners = useLoad<{ items: Array<{ id: string; email: string }> }>('/admin/complaints/owners');
  const history = useLoad<HistoryEntry[]>(`/admin/tables/Complaint/${id}/history`);
  const c = complaint.data;
  const reload = () => {
    void complaint.reload();
    void history.reload();
  };
  if (!c) return complaint.error ? <Status message={complaint.error} /> : <p role="status">{t('admin.common.loading')}</p>;
  const final = c.status === 'closed' || c.status === 'withdrawn';

  return (
    <div className="stack">
      <Section id="complaint-overview" title={`${c.reference}: ${c.summary}`}>
        <dl className="stack">
          <div>
            <dt>{t('admin.complaints.list.status')}</dt>
            <dd>{t(`admin.complaints.statuses.${c.status}`)}</dd>
          </div>
          <div>
            <dt>{t('admin.complaints.detail.owner')}</dt>
            <dd>{c.owner ? (c.owner.email ?? c.owner.id) : t('admin.complaints.list.noOwner')}</dd>
          </div>
          <div>
            <dt>{t('admin.complaints.detail.received')}</dt>
            <dd>{formatDay(c.receivedDate)}</dd>
          </div>
          <div>
            <dt>{t('admin.complaints.deadline.acknowledge')}</dt>
            <dd><DeadlineBadge m={c.deadlines.acknowledge} />{c.acknowledgedAt ? <span className="field__hint"> {t('admin.complaints.resolution.acknowledgedOn', { when: formatMoment(c.acknowledgedAt) })}</span> : null}</dd>
          </div>
          <div>
            <dt>{t('admin.complaints.deadline.resolve')}</dt>
            <dd><DeadlineBadge m={c.deadlines.resolve} /></dd>
          </div>
          <div>
            <dt>{t('admin.complaints.detail.customer')}</dt>
            <dd>{c.customer ? <Link href={`/admin/customers/${c.customer.id}`}>{fullName(c.customer)}</Link> : t('admin.complaints.detail.none')}</dd>
          </div>
          <div>
            <dt>{t('admin.complaints.detail.booking')}</dt>
            <dd>{c.booking ? <Link href={`/admin/bookings/${c.booking.id}`}>{c.booking.reference}</Link> : t('admin.complaints.detail.none')}</dd>
          </div>
        </dl>
      </Section>

      <Section id="complaint-status" title={t('admin.complaints.status.title')}>
        <StatusActions c={c} done={reload} />
      </Section>

      {c.outcome ? (
        <Section id="complaint-resolution-record" title={t('admin.complaints.resolution.title')}>
          <p><strong>{t('admin.complaints.resolution.outcome')}:</strong> {t(`admin.complaints.outcomes.${c.outcome}`)}</p>
          <p>{c.resolutionSummary}</p>
          <p className="field__hint">
            {c.resolvedAt ? t('admin.complaints.resolution.resolvedOn', { when: formatMoment(c.resolvedAt) }) : null}
            {c.closedAt ? ` ${t('admin.complaints.resolution.closedOn', { when: formatMoment(c.closedAt) })}` : null}
          </p>
        </Section>
      ) : null}
      {c.withdrawnAt ? <p className="field__hint">{t('admin.complaints.resolution.withdrawnOn', { when: formatMoment(c.withdrawnAt) })}</p> : null}

      <Section id="complaint-details" title={t('admin.complaints.detail.detailsTitle')}>
        {final ? (
          <>
            <p role="status">{t('admin.complaints.detail.finalNote', { status: t(`admin.complaints.statuses.${c.status}`).toLowerCase() })}</p>
            <p>{c.description}</p>
            <p className="field__hint">{c.complainantName}{c.complainantEmail ? `, ${c.complainantEmail}` : ''}</p>
          </>
        ) : (
          <EntityForm
            id="edit-complaint"
            fields={[
              ...complaintFields(owners.data?.items ?? [], false),
              { key: 'acknowledgeDueDate', label: t('admin.complaints.fields.acknowledgeDueDate'), type: 'date' },
              { key: 'resolveDueDate', label: t('admin.complaints.fields.resolveDueDate'), type: 'date', hint: t('admin.complaints.fields.deadlineHint') },
              { key: 'reason', label: t('admin.complaints.fields.reason'), type: 'text', maxLength: 500 },
            ]}
            initial={{
              summary: c.summary, description: c.description, channel: c.channel, category: c.category, complainantName: c.complainantName, complainantEmail: c.complainantEmail ?? '',
              ownerId: c.ownerId ?? '', acknowledgeDueDate: c.acknowledgeDueDate, resolveDueDate: c.resolveDueDate, reason: '',
            }}
            submit={t('admin.complaints.detail.save')}
            onSubmit={async (v) => {
              const s = (k: string) => String(v[k] ?? '').trim();
              const body: PatchBody = {
                version: c.version, summary: s('summary'), description: s('description'), channel: s('channel'), category: s('category'), complainantName: s('complainantName'),
                complainantEmail: s('complainantEmail') || null, ownerId: s('ownerId') || null,
              };
              if (s('acknowledgeDueDate') !== c.acknowledgeDueDate) body.acknowledgeDueDate = s('acknowledgeDueDate');
              if (s('resolveDueDate') !== c.resolveDueDate) body.resolveDueDate = s('resolveDueDate');
              if (s('reason')) body.reason = s('reason');
              const r = await api(`/admin/complaints/${c.id}`, { method: 'PATCH', body });
              if (r.status !== 200) return { ok: false, message: complaintError(r) };
              reload();
              return { ok: true, message: t('admin.complaints.detail.saved') };
            }}
          />
        )}
      </Section>

      <Section id="complaint-notes" title={t('admin.crm.notes.title')}>
        <RecordNotes entityType="Complaint" id={c.id} />
      </Section>

      <Section id="complaint-history" title={t('admin.complaints.history.title')}>
        {history.data && history.data.length > 0 ? (
          <ul className="stack">
            {history.data.map((h) => (
              <li key={h.id}>
                {t('admin.complaints.history.line', { what: actionLabel(h.action), when: formatMoment(h.occurredAt) })}
                {h.reason ? <span className="field__hint"> {t('admin.complaints.history.reason', { reason: h.reason })}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('admin.complaints.history.empty')}</p>
        )}
      </Section>
    </div>
  );
}
