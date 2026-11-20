'use client';

import { type ReactNode, useState } from 'react';
import type { ApiResult } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Status } from '../../auth/field';
import { catalogueError, type ApiCall } from '../catalogue/kit';
import { useStepUp } from '../step-up';

/**
 * A message for an API error in the pricing screens. The API's own codes have their own words; a 422 from the engine or
 * the schemas also carries fixed text (never a value from the request), which is used when there is no wording for the code.
 */
export function pricingError(r: Pick<ApiResult, 'status' | 'body'>): string {
  const code = r.body?.code;
  if (code === 'validation_failed') {
    const fields = Array.isArray((r.body as { fields?: unknown }).fields) ? ((r.body as { fields: unknown[] }).fields.filter((f) => typeof f === 'string') as string[]) : [];
    return fields.length > 0 ? t('admin.pricing.errors.validation_fields', { fields: fields.join(', ') }) : t('admin.pricing.errors.validation_failed');
  }
  if (code) {
    try {
      return t(`admin.pricing.errors.${code}`);
    } catch {
      /* no wording for this code here */
    }
  }
  if ((r.status === 409 || r.status === 422) && typeof r.body?.message === 'string' && r.body.message !== '') return r.body.message;
  return catalogueError(r);
}

/** Call signatures are written as interfaces because the copy test reads an arrow followed by text and a tag as page text. */
export interface AsyncAction {
  (): Promise<void>;
}
export interface ChooseOne {
  (value: string): void;
}
export type Options = ReadonlyArray<{ value: string; label: string }>;
export interface Action {
  (): void;
}
export interface ChooseMany<V> {
  (next: V[]): void;
}

export type Message = { text: string; tone: 'error' | 'info' } | null;

/**
 * Runs panel actions: asks for the authenticator code when the API says the action needs a recent check, shows the
 * outcome in a live region, and never throws on a network failure.
 */
export function useRunner() {
  const stepUp = useStepUp();
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiResult | null>(null);

  async function run(call: ApiCall, okText?: string): Promise<ApiResult | null> {
    setBusy(true);
    setMessage(null);
    setFailure(null);
    let r: ApiResult;
    try {
      r = await stepUp.run(call);
    } catch {
      setBusy(false);
      setMessage({ text: t('admin.pricing.errors.network'), tone: 'error' });
      return null;
    }
    setBusy(false);
    if (r.status >= 200 && r.status < 300) {
      setMessage(okText ? { text: okText, tone: 'info' } : null);
      return r;
    }
    setFailure(r);
    setMessage({ text: pricingError(r), tone: 'error' });
    return null;
  }

  return { run, busy, message, failure, prompt: stepUp.prompt, status: <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />, clear: () => setMessage(null) };
}

/** True when the failure is the optimistic lock: someone else saved first, so the screen should be reloaded. */
export const isVersionConflict = (r: ApiResult | null): boolean => r?.status === 409 && (r.body?.code === 'version_conflict' || r.body?.code === 'current_version_changed');

// ---- Small labelled fields, each with an optional hint and error tied to the input ----

interface FieldBase {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
}

function describedBy(id: string, hint?: string, error?: string | null): string | undefined {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function Messages({ id, hint, error }: { id: string; hint?: string; error?: string | null }) {
  return (
    <>
      {hint ? <p id={`${id}-hint`} className="field__hint">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="form-error">{error}</p> : null}
    </>
  );
}

export function TextField({ id, label, hint, error, required, value, onChange, type = 'text', inputMode, maxLength, min, max, disabled, autoComplete }: FieldBase & {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number' | 'date' | 'datetime-local' | 'search';
  inputMode?: 'decimal' | 'numeric';
  maxLength?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  autoComplete?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id} type={type} inputMode={inputMode} value={value} maxLength={maxLength} min={min} max={max} required={required} disabled={disabled} autoComplete={autoComplete ?? 'off'}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} onChange={(e) => onChange(e.target.value)}
      />
      <Messages id={id} hint={hint} error={error} />
    </div>
  );
}

export function SelectField({ id, label, hint, error, required, value, onChange, options, disabled }: FieldBase & {
  value: string;
  onChange: ChooseOne;
  options: Options;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select id={id} value={value} required={required} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Messages id={id} hint={hint} error={error} />
    </div>
  );
}

export function CheckField({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="field field--check">
      <label htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={describedBy(id, hint)} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
      <Messages id={id} hint={hint} />
    </div>
  );
}

/** A group of checkboxes under one legend (a fieldset), so a screen reader announces what the boxes are for. */
export function CheckGroup<V extends string | number>({ id, legend, hint, options, selected, onChange }: {
  id: string;
  legend: string;
  hint?: string;
  options: ReadonlyArray<{ value: V; label: string }>;
  selected: readonly V[];
  onChange: ChooseMany<V>;
}) {
  return (
    <fieldset className="field" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend>{legend}</legend>
      <div className="actions">
        {options.map((o) => (
          <label key={String(o.value)} htmlFor={`${id}-${String(o.value)}`}>
            <input
              id={`${id}-${String(o.value)}`} type="checkbox" checked={selected.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))}
            />{' '}
            {o.label}
          </label>
        ))}
      </div>
      {hint ? <p id={`${id}-hint`} className="field__hint">{hint}</p> : null}
    </fieldset>
  );
}

/** A page region whose text is announced when it changes (a quote, a result). */
export function Live({ children }: { children: ReactNode }) {
  return <div aria-live="polite">{children}</div>;
}
