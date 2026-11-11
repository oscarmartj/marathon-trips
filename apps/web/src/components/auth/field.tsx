import type { InputHTMLAttributes } from 'react';

/** A labelled input. The label is always visible (WCAG 2.2: labels or instructions). */
export function Field({ label, id, ...input }: { label: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} {...input} />
    </div>
  );
}

/** Announces errors and confirmations to screen readers. */
export function Status({ message, tone = 'error' }: { message: string | null; tone?: 'error' | 'info' }) {
  if (!message) return null;
  return (
    <p className={tone === 'error' ? 'form-error' : 'notice'} role={tone === 'error' ? 'alert' : 'status'}>
      {message}
    </p>
  );
}
