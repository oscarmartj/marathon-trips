'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { type Meta, type QueryState, errText, maybe, queryBody } from './shared';

interface CsvError {
  row: number;
  column: string;
  code: string;
}

function line(e: CsvError): string {
  const message = maybe(`admin.table.csvCodes.${e.code}`, e.code);
  if (e.row === 0 && e.column === '') return t('admin.table.csv.errorFile', { message });
  if (e.row === 0) return t('admin.table.csv.errorColumn', { column: e.column, message });
  if (e.column === '') return t('admin.table.csv.errorRow', { row: e.row, message });
  return t('admin.table.csv.errorLine', { row: e.row, column: e.column, message });
}

export function CsvTools({ meta, query, onImported }: { meta: Meta; query: QueryState; onImported: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [errors, setErrors] = useState<CsvError[]>([]);
  const [valid, setValid] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);

  async function exportCsv() {
    const res = await fetch(`/api/admin/tables/${meta.entityType}/export`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-MT-CSRF': '1' }, body: JSON.stringify({ query: queryBody(query) }),
    });
    if (!res.ok) {
      let body: { code?: string } = {};
      try {
        body = (await res.json()) as { code?: string };
      } catch {
        body = {};
      }
      setMessage({ text: errText({ status: res.status, body }), tone: 'error' });
      return;
    }
    const blob = await res.blob();
    // The proxy forwards only listed headers (not Content-Disposition), so the name is built here as the API builds it.
    const name = `${meta.entityType.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
    setMessage({ text: t('admin.table.csv.exported'), tone: 'info' });
  }

  async function run(dryRun: boolean) {
    if (text === null) {
      setMessage({ text: t('admin.table.csv.chooseFile'), tone: 'error' });
      return;
    }
    const r = await api<{ valid: boolean; committed: boolean; rows: number; errors: CsvError[] }>(`/admin/tables/${meta.entityType}/import`, { method: 'POST', body: { csv: text, dryRun } });
    if (r.status !== 200) {
      setMessage({ text: errText(r), tone: 'error' });
      return;
    }
    const b = r.body;
    setErrors(b.errors);
    if (!b.valid) {
      setValid(null);
      setMessage({ text: t('admin.table.csv.invalid'), tone: 'error' });
    } else if (b.committed) {
      setValid(null);
      setText(null);
      setFileKey((k) => k + 1);
      setMessage({ text: t('admin.table.csv.imported', { rows: b.rows }), tone: 'info' });
      onImported();
    } else {
      setValid(b.rows);
      setMessage({ text: t('admin.table.csv.valid', { rows: b.rows }), tone: 'info' });
    }
  }

  return (
    <fieldset className="stack">
      <legend>{t('admin.table.csv.heading')}</legend>
      {meta.can.export ? (
        <button className="btn" type="button" onClick={exportCsv}>
          {t('admin.table.csv.export')}
        </button>
      ) : null}
      {meta.can.import ? (
        <div className="stack">
          <div className="field">
            <label htmlFor="csv-file">{t('admin.table.csv.file')}</label>
            <input
              key={fileKey}
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              aria-describedby="csv-hint"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                setText(f ? await f.text() : null);
                setErrors([]);
                setValid(null);
              }}
            />
          </div>
          <p id="csv-hint">{t('admin.table.csv.hint', { columns: meta.importColumns.join(', ') })}</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => run(true)}>
              {t('admin.table.csv.check')}
            </button>
            <button className="btn" type="button" onClick={() => run(false)} disabled={valid === null}>
              {t('admin.table.csv.commit')}
            </button>
          </div>
          {errors.length > 0 ? (
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{line(e)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {message ? <Status message={message.text} tone={message.tone} /> : null}
    </fieldset>
  );
}
