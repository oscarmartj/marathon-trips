'use client';

import { useState } from 'react';
import { Status } from '../auth/field';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { accountsOf, differenceLabel, runStatusLabel, sideText } from '@/lib/reconciliation-panel';
import type { DifferenceRow, RunRow } from '@/lib/reconciliation-panel';
import { Section, useLoad } from './catalogue/kit';
import { useStepUp } from './step-up';

type Message = { text: string; tone: 'error' | 'info' } | null;

/** The daily reconciliations (task 4.6): the latest runs, their differences on demand, and "run now" with step-up. */
export function ReconciliationPanel() {
  const { data, reload } = useLoad<{ runs: RunRow[] }>('/admin/payments/reconciliation/runs');
  const [open, setOpen] = useState<Record<string, DifferenceRow[] | undefined>>({});
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp();
  if (!data) return null;

  async function toggle(id: string) {
    if (open[id]) return setOpen((o) => ({ ...o, [id]: undefined }));
    const r = await api<{ differences: DifferenceRow[] }>(`/admin/payments/reconciliation/runs/${id}`);
    if (r.status === 200) setOpen((o) => ({ ...o, [id]: (r.body as unknown as { differences: DifferenceRow[] }).differences }));
  }

  async function runNow(accountId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await stepUp.run(() => api(`/admin/payments/reconciliation/accounts/${accountId}/run`, { method: 'POST' }));
      const code = (r.body as { code?: string } | null)?.code;
      if (r.status === 200) setMessage({ text: t('admin.reconciliation.ran', { status: runStatusLabel((r.body as unknown as RunRow).status) }), tone: 'info' });
      else if (r.status === 409) setMessage({ text: t('admin.reconciliation.running'), tone: 'error' });
      else if (r.status === 429) setMessage({ text: t('admin.reconciliation.tooMany'), tone: 'error' });
      else if (r.status === 403 && code === 'step_up_required') setMessage({ text: t('admin.reconciliation.stepUpCancelled'), tone: 'error' });
      else setMessage({ text: t('admin.reconciliation.forbidden'), tone: 'error' });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="reconciliation" title={t('admin.reconciliation.runsHeading')}>
      {accountsOf(data.runs).map((a) => (
        <p key={a.id}><button className="btn" type="button" disabled={busy} onClick={() => void runNow(a.id)}>{t('admin.reconciliation.runNow', { account: a.name })}</button></p>
      ))}
      {data.runs.length === 0 ? <p>{t('admin.reconciliation.none')}</p> : (
        <ul>
          {data.runs.map((r) => (
            <li key={r.id}>
              {t('admin.reconciliation.row', { account: r.accountName, date: r.forDate, attempt: String(r.attempt), status: runStatusLabel(r.status), count: String(r.differenceCount), checked: String(r.checkedObjects) })}
              {r.differenceCount > 0 ? <> <button className="link-button" type="button" aria-expanded={!!open[r.id]} onClick={() => void toggle(r.id)}>{t(open[r.id] ? 'admin.reconciliation.hide' : 'admin.reconciliation.details')}</button></> : null}
              {open[r.id] ? (
                open[r.id]!.length === 0 ? <p>{t('admin.reconciliation.noDifferences')}</p> : (
                  <ul>
                    {open[r.id]!.map((d, i) => {
                      const ours = sideText(d.ours);
                      const gateway = sideText(d.gateway);
                      return (
                        <li key={`${d.code}-${d.entityId}-${i}`}>
                          {t('admin.reconciliation.difference', { code: differenceLabel(d.code), entity: d.entityType, id: d.entityId })}
                          {ours ? <> · {t('admin.reconciliation.ours', { value: ours })}</> : null}
                          {gateway ? <> · {t('admin.reconciliation.gateway', { value: gateway })}</> : null}
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {stepUp.prompt}
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
    </Section>
  );
}
