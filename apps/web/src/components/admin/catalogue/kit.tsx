'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiResult } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Status } from '../../auth/field';
import { errorMessage } from '../step-up';

/** A message for an API error: the catalogue's own wording for the code when there is one, else the general one. */
export function catalogueError(r: { status: number; body: { code?: string } }): string {
  const code = r.body?.code;
  if (code) {
    try {
      return t(`admin.catalogue.errors.${code}`);
    } catch {
      /* falls through to the general message */
    }
  }
  if (r.status === 422) return t('admin.catalogue.errors.validation_failed');
  return errorMessage(r);
}

/** Looks up a label, falling back to the raw value for something the catalogue does not name. */
export function label(key: string, fallback: string): string {
  try {
    return t(key);
  } catch {
    return fallback;
  }
}

/** Loads one API resource, and again on demand. A response that a newer request has overtaken is ignored. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    if (path === null) return;
    const mine = ++sequence.current;
    const r = await api<T>(path);
    if (mine !== sequence.current) return;
    if (r.status === 200) {
      setData(r.body as unknown as T);
      setError(null);
    } else setError(catalogueError(r));
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'datetime-local' | 'select' | 'checkbox' | 'textarea';
  options?: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
  maxLength?: number;
  hint?: string;
  min?: number;
  max?: number;
}
export type Values = Record<string, string | boolean>;
export type Outcome = { ok: true; message?: string } | { ok: false; message: string };
/** Call signatures are written as interfaces because the copy test reads an arrow followed by text and a tag as page text. */
export interface SubmitFn {
  (values: Values): Promise<Outcome>;
}
export interface BodySubmit {
  (body: Record<string, unknown>): Promise<Outcome>;
}
export interface ApiCall {
  (): Promise<ApiResult>;
}

/**
 * A small form for one catalogue record. It owns the field values and the message; the caller turns the values into an API
 * call. Every field has a visible label, and errors and confirmations are announced.
 */
export function EntityForm({
  id, fields, initial, submit, onSubmit, resetOnSuccess = false, extra,
}: {
  id: string;
  fields: readonly FieldDef[];
  initial: Values;
  submit: string;
  onSubmit: SubmitFn;
  resetOnSuccess?: boolean;
  extra?: ReactNode;
}) {
  const [values, setValues] = useState<Values>(initial);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: string, v: string | boolean) => setValues((prev) => ({ ...prev, [key]: v }));

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const out = await onSubmit(values);
    setBusy(false);
    if (out.ok) {
      setMessage(out.message ? { text: out.message, tone: 'info' } : null);
      if (resetOnSuccess) setValues(initial);
    } else setMessage({ text: out.message, tone: 'error' });
  }

  return (
    <form onSubmit={handle} className="form stack catalogue-form">
      {fields.some((f) => (f.required === true)) ? <p className="field__hint">{t('admin.catalogue.common.requiredNote')}</p> : null}
      {fields.map((f) => {
        const fid = `${id}-${f.key}`;
        const hint = f.hint ? `${fid}-hint` : undefined;
        const common = { id: fid, 'aria-describedby': hint, required: f.required };
        const v = values[f.key];
        return (
          <div className={f.type === 'checkbox' ? 'field field--check' : 'field'} key={f.key}>
            {f.type === 'checkbox' ? (
              <label htmlFor={fid}>
                <input {...common} type="checkbox" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}
              </label>
            ) : (
              <label htmlFor={fid}>
                {f.label}
                {f.required ? <span aria-hidden="true"> *</span> : null}
              </label>
            )}
            {f.type === 'textarea' ? (
              <textarea {...common} rows={3} maxLength={f.maxLength} value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === 'select' ? (
              <select {...common} value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === 'checkbox' ? null : (
              <input {...common} type={f.type} inputMode={f.type === 'number' ? 'numeric' : undefined} min={f.min} max={f.max} maxLength={f.maxLength} value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} />
            )}
            {f.hint ? <p id={hint} className="field__hint">{f.hint}</p> : null}
          </div>
        );
      })}
      {extra}
      <div className="actions">
        <button className="btn" type="submit" disabled={busy}>
          {submit}
        </button>
      </div>
      {message ? <Status message={message.text} tone={message.tone} /> : null}
    </form>
  );
}

/** A section of a panel page with its own heading (h2), so screen reader users can jump between sections. */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="card stack">
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

/** Runs an API call and turns the result into an Outcome for a form. */
export async function outcome(call: ApiCall, okMessage?: string): Promise<Outcome> {
  const r = await call();
  return r.status >= 200 && r.status < 300 ? { ok: true, message: okMessage } : { ok: false, message: catalogueError(r) };
}

/** A button that asks nothing and runs one API call; the message appears beside it. */
export function ActionButton({ text, run, onDone, danger = false }: { text: string; run: ApiCall; onDone: () => void; danger?: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="action">
      <button
        type="button"
        className={danger ? 'link-button' : 'btn'}
        onClick={async () => {
          const r = await run();
          if (r.status >= 200 && r.status < 300) {
            setMessage(null);
            onDone();
          } else setMessage(catalogueError(r));
        }}
      >
        {text}
      </button>
      <Status message={message} />
    </span>
  );
}

export const formatDay = (iso: string | null | undefined): string => (iso ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : '');
