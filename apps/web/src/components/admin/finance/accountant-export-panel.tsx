'use client';

import { useState, type FormEvent } from 'react';
import { EXPORT_DATASETS, exportBody, exportErrorMessage } from '@/lib/finance-panel';
import { t } from '@/lib/i18n-admin';
import { Field, Status } from '../../auth/field';
import { Section } from '../catalogue/kit';
import { useStepUp } from '../step-up';

/** The accountant's files (task 6.6). The server builds the file, audits it and asks for a fresh code; this only downloads it. */
export function AccountantExportPanel() {
  const { run, prompt } = useStepUp();
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = exportBody(String(f.get('dataset') ?? ''), String(f.get('exportFrom') ?? ''), String(f.get('exportTo') ?? ''));
    if (!body) {
      setMessage({ text: t('admin.tripResults.export.errors.validation_failed'), tone: 'error' });
      return;
    }
    setMessage({ text: t('admin.tripResults.export.working'), tone: 'info' });
    // The proxy forwards only listed headers (not Content-Disposition), so the name is built here as the API builds it.
    const name = `marathon-trips-${body.dataset.replace(/_/g, '-')}-${body.from.replace(/-/g, '')}-${body.to.replace(/-/g, '')}.csv`;
    const r = await run(async () => {
      const res = await fetch('/api/admin/payments/exports/accountant', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-MT-CSRF': '1' }, body: JSON.stringify(body),
      });
      if (!res.ok) return { status: res.status, body: (await res.json().catch(() => ({}))) as { code?: string } };
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      URL.revokeObjectURL(link.href);
      return { status: 200, body: { rows: res.headers.get('X-Row-Count') ?? '' } };
    });
    if (r.status === 200) setMessage({ text: t('admin.tripResults.export.done', { rows: String(r.body.rows ?? '') }), tone: 'info' });
    else setMessage({ text: exportErrorMessage(r), tone: 'error' });
  }

  return (
    <Section id="accountant-export" title={t('admin.tripResults.export.title')}>
      <p>{t('admin.tripResults.export.intro')}</p>
      <form className="stack form" onSubmit={(e) => void submit(e)} aria-label={t('admin.tripResults.export.title')}>
        <div className="field">
          <label htmlFor="dataset">{t('admin.tripResults.export.dataset')}</label>
          <select id="dataset" name="dataset" defaultValue="trip_result">
            {EXPORT_DATASETS.map((d) => <option key={d} value={d}>{t(`admin.tripResults.export.datasets.${d}`)}</option>)}
          </select>
        </div>
        <Field label={t('admin.tripResults.export.from')} id="exportFrom" type="date" required />
        <Field label={t('admin.tripResults.export.to')} id="exportTo" type="date" required />
        <p>{t('admin.tripResults.export.note')}</p>
        <div className="actions"><button className="btn" type="submit">{t('admin.tripResults.export.download')}</button></div>
      </form>
      <Status message={message?.text ?? null} tone={message?.tone} />
      {prompt}
    </Section>
  );
}
