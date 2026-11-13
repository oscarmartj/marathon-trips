'use client';

import { useState, type FormEvent } from 'react';
import type { BookingTravellersView, TravellerView } from '@mt/shared';
import { Field, Status } from '@/components/auth/field';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';
import { formFrom, saveErrorKey, toDetailsBody, travellerPath, type DetailsField, type DetailsForm } from '@/lib/travellers';

/** The sentence about the deadline, from the API's date; the browser never works a deadline out. */
export function DeadlineNote({ view }: { view: Pick<BookingTravellersView, 'editable' | 'reason' | 'editableUntil'> }) {
  if (view.reason === 'deadline_passed' && view.editableUntil) return <p className="notice" role="status">{t('account.travellers.reason.deadline_passed', { date: formatDate(view.editableUntil) })}</p>;
  if (view.reason === 'booking_status') return <p className="notice" role="status">{t('account.travellers.reason.booking_status')}</p>;
  return <p>{view.editableUntil ? t('account.travellers.until', { date: formatDate(view.editableUntil) }) : t('account.travellers.noDeadline')}</p>;
}

function Saved({ traveller }: { traveller: TravellerView }) {
  const d = traveller.details;
  if (!d) return <p>{t('account.travellers.none')}</p>;
  return (
    <dl>
      <div><dt>{t('account.travellers.fields.givenName')}</dt><dd>{d.givenName}</dd></div>
      <div><dt>{t('account.travellers.fields.familyName')}</dt><dd>{d.familyName}</dd></div>
      {d.dateOfBirth ? <div><dt>{t('account.travellers.fields.dateOfBirth')}</dt><dd>{formatDate(d.dateOfBirth)}</dd></div> : null}
      {d.emergencyContactName ? <div><dt>{t('account.travellers.fields.emergencyContactName')}</dt><dd>{d.emergencyContactName}</dd></div> : null}
      {d.emergencyContactPhone ? <div><dt>{t('account.travellers.fields.emergencyContactPhone')}</dt><dd>{d.emergencyContactPhone}</dd></div> : null}
    </dl>
  );
}

function TravellerForm({ reference, traveller, editable, onView }: { reference: string; traveller: TravellerView; editable: boolean; onView: (v: BookingTravellersView) => void }) {
  const [form, setForm] = useState<DetailsForm>(formFrom(traveller.details));
  const [errors, setErrors] = useState<Partial<Record<DetailsField, string>>>({});
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = (f: string) => `traveller-${traveller.slot}-${f}`;
  const set = (key: keyof DetailsForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const err = (f: DetailsField) => (errors[f] ? t(`account.travellers.errors.${errors[f]}`) : undefined);
  const invalid = (f: DetailsField) => (errors[f] ? { 'aria-invalid': true, 'aria-describedby': `${id(f)}-error` } : {});

  async function run(method: 'PUT' | 'DELETE', body?: object, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<BookingTravellersView>(travellerPath(reference, traveller.slot), { method, ...(body ? { body } : {}) });
      if (r.status === 200) {
        const view = r.body as BookingTravellersView;
        onView(view);
        if (method === 'DELETE') setForm(formFrom(null));
        setMessage({ tone: 'info', text: t(done!) });
      } else {
        setMessage({ tone: 'error', text: t(`account.travellers.errors.${saveErrorKey(r.status, r.body.code)}`) });
      }
    } catch {
      setMessage({ tone: 'error', text: t('account.travellers.errors.network') });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const result = toDetailsBody(form, traveller.runner);
    if (!result.ok) {
      setErrors(result.errors);
      setMessage(null);
      const first = (['givenName', 'familyName', 'dateOfBirth', 'estimatedFinish', 'emergencyContactName', 'emergencyContactPhone'] as const).find((f) => result.errors[f]);
      if (first) document.getElementById(id(first === 'estimatedFinish' ? 'finishHours' : first))?.focus();
      return;
    }
    setErrors({});
    void run('PUT', result.body, 'account.travellers.saved');
  }

  const heading = t(traveller.isLead ? 'account.travellers.placeLead' : 'account.travellers.place', { n: traveller.slot });
  const legend = (
    <>
      {heading}: {t(`account.travellers.type.${traveller.participationType}`)}{' '}
      <span>({t(traveller.complete ? 'account.travellers.complete' : 'account.travellers.incomplete')})</span>
    </>
  );
  if (!editable) {
    return (
      <section className="stack" aria-labelledby={id('heading')}>
        <h2 id={id('heading')}>{legend}</h2>
        <Saved traveller={traveller} />
      </section>
    );
  }
  return (
    <form className="stack form" onSubmit={submit} noValidate>
      <fieldset className="stack">
        <legend>{legend}</legend>
        <Field label={t('account.travellers.fields.givenName')} id={id('givenName')} value={form.givenName} onChange={set('givenName')} required maxLength={100} autoComplete="off" {...invalid('givenName')} />
        {err('givenName') ? <p id={`${id('givenName')}-error`} className="form-error" role="alert">{err('givenName')}</p> : null}
        <Field label={t('account.travellers.fields.familyName')} id={id('familyName')} value={form.familyName} onChange={set('familyName')} required maxLength={100} autoComplete="off" {...invalid('familyName')} />
        {err('familyName') ? <p id={`${id('familyName')}-error`} className="form-error" role="alert">{err('familyName')}</p> : null}
        {traveller.runner ? (
          <>
            <Field label={t('account.travellers.fields.dateOfBirth')} id={id('dateOfBirth')} type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} autoComplete="off" {...invalid('dateOfBirth')} />
            <p className="field__hint">{t('account.travellers.fields.dateOfBirthHint')}</p>
            {err('dateOfBirth') ? <p id={`${id('dateOfBirth')}-error`} className="form-error" role="alert">{err('dateOfBirth')}</p> : null}
            <Field label={t('account.travellers.fields.finishHours')} id={id('finishHours')} inputMode="numeric" value={form.finishHours} onChange={set('finishHours')} maxLength={2} autoComplete="off" {...invalid('estimatedFinish')} />
            <Field label={t('account.travellers.fields.finishMinutes')} id={id('finishMinutes')} inputMode="numeric" value={form.finishMinutes} onChange={set('finishMinutes')} maxLength={2} autoComplete="off" {...invalid('estimatedFinish')} />
            <p className="field__hint">{t('account.travellers.fields.finishHint')}</p>
            {err('estimatedFinish') ? <p id={`${id('estimatedFinish')}-error`} className="form-error" role="alert">{err('estimatedFinish')}</p> : null}
          </>
        ) : null}
        <Field label={t('account.travellers.fields.emergencyContactName')} id={id('emergencyContactName')} value={form.emergencyContactName} onChange={set('emergencyContactName')} maxLength={100} autoComplete="off" {...invalid('emergencyContactName')} />
        {err('emergencyContactName') ? <p id={`${id('emergencyContactName')}-error`} className="form-error" role="alert">{err('emergencyContactName')}</p> : null}
        <Field label={t('account.travellers.fields.emergencyContactPhone')} id={id('emergencyContactPhone')} type="tel" value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} maxLength={20} autoComplete="off" {...invalid('emergencyContactPhone')} />
        <p className="field__hint">{t('account.travellers.fields.emergencyHint')}</p>
        {err('emergencyContactPhone') ? <p id={`${id('emergencyContactPhone')}-error`} className="form-error" role="alert">{err('emergencyContactPhone')}</p> : null}
      </fieldset>
      <Status message={message?.text ?? null} tone={message?.tone} />
      <p>
        <button className="btn" type="submit" disabled={busy} aria-disabled={busy}>{busy ? t('account.travellers.saving') : t('account.travellers.save')}</button>
        {traveller.details ? <> <button className="btn btn--accent" type="button" disabled={busy} onClick={() => void run('DELETE', undefined, 'account.travellers.cleared')}>{t('account.travellers.clear')}</button></> : null}
      </p>
    </form>
  );
}

/**
 * The places of a booking, one form each while the API says they can be changed, plain text otherwise. Whether a form
 * is shown, and the deadline, are the API's (`editable`, `editableUntil`); each save answers with the fresh view.
 */
export function TravellerForms({ reference, initial }: { reference: string; initial: BookingTravellersView }) {
  const [view, setView] = useState(initial);
  return (
    <div className="container stack section">
      <p>{t('account.travellers.intro')}</p>
      <p>{t('account.travellers.notAsked')}</p>
      <DeadlineNote view={view} />
      {view.travellers.map((tr) => (
        <TravellerForm key={tr.slot} reference={reference} traveller={tr} editable={view.editable} onView={setView} />
      ))}
    </div>
  );
}
