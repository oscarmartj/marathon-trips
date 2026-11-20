'use client';

import { PARTICIPATION_TYPES, RULE_DIRECTIONS, RULE_KINDS, RULE_TARGETS } from '@mt/shared';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import type { ApiCall } from '../catalogue/kit';
import { offsetAtInstant, offsetAtLocal } from '@/lib/panel-time';
import {
  adjustmentBody, adjustmentPatch, creationFields, emptyAdjustmentForm, patchIsEmpty, rowToForm,
  type AdjustmentForm, type FormFailure,
} from '@/lib/pricing-panel';
import { t } from '@/lib/i18n-admin';
import { type Action, type AsyncAction, isVersionConflict, CheckField, CheckGroup, SelectField, TextField, useRunner } from './pricing-kit';

export interface ScopeOption {
  value: string;
  label: string;
}
export type Audience = 'rule' | 'promo';

const pick = (keys: readonly string[], prefix: string) => keys.map((k) => ({ value: k, label: t(`${prefix}.${k}`) }));
const zone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

/**
 * One form for a rule or a promo code, to create or to change. Creating sends every field; changing sends only the fields
 * that differ from the saved row, with its version number (the API keeps what is left out and refuses a stale version).
 * Percentages and dollars are turned into basis points and cents by cutting text; nothing is calculated here.
 */
export function AdjustmentFormView({ audience, row, editions, packages, defaultScope, onSaved, onReload, onCancel }: {
  audience: Audience;
  row?: Record<string, unknown>;
  editions: ScopeOption[];
  packages: ScopeOption[];
  defaultScope?: { scopeType: string; scopeId: string };
  onSaved: AsyncAction;
  onReload?: AsyncAction;
  onCancel?: Action;
}) {
  const editing = row !== undefined;
  const base = audience === 'rule' ? '/admin/pricing/rules' : '/admin/pricing/promo-codes';
  const id = `${audience}-${editing ? 'edit' : 'new'}`;
  const [form, setForm] = useState<AdjustmentForm>(() => (editing ? rowToForm(row, offsetAtInstant) : { ...emptyAdjustmentForm(), ...(defaultScope ?? {}) }));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Map<string, FormFailure>>(new Map());
  const [info, setInfo] = useState<string | null>(null);
  const runner = useRunner();
  const set = <K extends keyof AdjustmentForm>(key: K, value: AdjustmentForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setInfo(null);
    setErrors((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  };
  const err = (field: string): string | null => {
    const reasonCode = errors.get(field);
    return reasonCode ? t(`admin.pricing.formErrors.${reasonCode}`) : null;
  };
  const percent = form.effectMode === 'percent';
  const scopeOptions = form.scopeType === 'package' ? packages : editions;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setInfo(null);
    const built = adjustmentBody(form, { audience, offsetMinutes: offsetAtLocal });
    const created = editing ? ({ ok: true, fields: {} } as const) : creationFields(form, audience);
    if (!built.ok || !created.ok) {
      setErrors(new Map([...(built.ok ? [] : built.errors), ...(created.ok ? [] : created.errors)].map((x) => [x.field, x.reason])));
      runner.clear();
      return;
    }
    setErrors(new Map());
    let call: ApiCall;
    if (editing) {
      const patch = adjustmentPatch(row, built.body, reason);
      if (patchIsEmpty(patch)) {
        setInfo(t('admin.pricing.form.nothingChanged'));
        runner.clear();
        return;
      }
      call = () => api(`${base}/${String(row.id)}`, { method: 'PATCH', body: patch });
    } else {
      call = () => api(`${base}`, { method: 'POST', body: { ...created.fields, ...built.body, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
    }
    const r = await runner.run(call, t(editing ? 'admin.pricing.form.saved' : 'admin.pricing.form.created'));
    if (r) {
      if (!editing) {
        setForm({ ...emptyAdjustmentForm(), ...(defaultScope ?? {}) });
        setReason('');
      }
      await onSaved();
    }
  }

  return (
    <form className="form stack catalogue-form" onSubmit={submit} aria-label={t(`admin.pricing.form.${audience}.${editing ? 'edit' : 'new'}`)}>
      {runner.prompt}
      <p className="field__hint">{t('admin.catalogue.common.requiredNote')}</p>

      <fieldset className="stack">
        <legend>{t('admin.pricing.form.basics')}</legend>
        <TextField id={`${id}-label`} label={t('admin.pricing.form.label')} hint={t('admin.pricing.form.labelHint')} required maxLength={80} value={form.label} onChange={(v) => set('label', v)} error={err('label')} />
        {audience === 'promo' ? (
          editing ? (
            <p>{t('admin.pricing.form.codeIs', { code: form.code })}</p>
          ) : (
            <TextField id={`${id}-code`} label={t('admin.pricing.form.code')} hint={t('admin.pricing.form.codeHint')} required maxLength={32} value={form.code} onChange={(v) => set('code', v)} error={err('code')} />
          )
        ) : (
          <>
            <SelectField id={`${id}-kind`} label={t('admin.pricing.form.kind')} hint={t(`admin.pricing.kindHints.${form.kind}`)} value={form.kind} onChange={(v) => set('kind', v)} options={pick(RULE_KINDS, 'admin.pricing.kinds')} />
            <SelectField id={`${id}-direction`} label={t('admin.pricing.form.direction')} value={form.direction} onChange={(v) => set('direction', v)} options={pick(RULE_DIRECTIONS, 'admin.pricing.directions')} />
          </>
        )}
        {editing ? (
          <p>{t('admin.pricing.form.scopeFixed', { scope: scopeText(form, editions, packages) })}</p>
        ) : (
          <>
            <SelectField
              id={`${id}-scopeType`} label={t('admin.pricing.form.scopeType')} hint={t('admin.pricing.form.scopeHint')} value={form.scopeType}
              onChange={(v) => setForm((f) => ({ ...f, scopeType: v, scopeId: '' }))} options={pick(['global', 'edition', 'package'], 'admin.pricing.scopes')}
            />
            {form.scopeType !== 'global' ? (
              <SelectField
                id={`${id}-scopeId`} label={t(form.scopeType === 'package' ? 'admin.pricing.form.scopePackage' : 'admin.pricing.form.scopeEdition')} required value={form.scopeId}
                onChange={(v) => set('scopeId', v)} error={err('scopeId')} options={[{ value: '', label: t('admin.pricing.form.choose') }, ...scopeOptions]}
              />
            ) : null}
          </>
        )}
      </fieldset>

      <fieldset className="stack">
        <legend>{t('admin.pricing.form.effect')}</legend>
        <SelectField id={`${id}-effectMode`} label={t('admin.pricing.form.effectMode')} value={form.effectMode} onChange={(v) => set('effectMode', v)} options={pick(['percent', 'fixed'], 'admin.pricing.effectModes')} />
        <TextField
          id={`${id}-value`} label={t(percent ? 'admin.pricing.form.valuePercent' : 'admin.pricing.form.valueFixed')} hint={t(percent ? 'admin.pricing.form.valuePercentHint' : 'admin.pricing.form.valueFixedHint')}
          required inputMode="decimal" value={form.value} onChange={(v) => set('value', v)} error={err('value')}
        />
        {percent ? null : <SelectField id={`${id}-per`} label={t('admin.pricing.form.per')} value={form.per} onChange={(v) => set('per', v)} options={pick(['person', 'booking'], 'admin.pricing.pers')} />}
        <SelectField id={`${id}-appliesTo`} label={t('admin.pricing.form.appliesTo')} value={form.appliesTo} onChange={(v) => set('appliesTo', v)} options={pick(RULE_TARGETS, 'admin.pricing.targets')} />
      </fieldset>

      <fieldset className="stack">
        <legend>{t('admin.pricing.form.conditions')}</legend>
        <p className="field__hint">{t('admin.pricing.form.conditionsHelp')}</p>
        <TextField id={`${id}-booked`} label={t('admin.pricing.form.bookedOnOrBefore')} type="date" value={form.bookedOnOrBefore} onChange={(v) => set('bookedOnOrBefore', v)} error={err('bookedOnOrBefore')} />
        <div className="inline-form">
          <TextField id={`${id}-mindays`} label={t('admin.pricing.form.minDays')} inputMode="numeric" value={form.minDaysBeforeCheckIn} onChange={(v) => set('minDaysBeforeCheckIn', v)} error={err('minDaysBeforeCheckIn')} />
          <TextField id={`${id}-maxdays`} label={t('admin.pricing.form.maxDays')} inputMode="numeric" value={form.maxDaysBeforeCheckIn} onChange={(v) => set('maxDaysBeforeCheckIn', v)} error={err('maxDaysBeforeCheckIn')} />
        </div>
        <div className="inline-form">
          <TextField id={`${id}-mintravellers`} label={t('admin.pricing.form.minTravellers')} inputMode="numeric" value={form.minTravellers} onChange={(v) => set('minTravellers', v)} error={err('minTravellers')} />
          <TextField id={`${id}-maxtravellers`} label={t('admin.pricing.form.maxTravellers')} inputMode="numeric" value={form.maxTravellers} onChange={(v) => set('maxTravellers', v)} error={err('maxTravellers')} />
        </div>
        <CheckGroup id={`${id}-occupancies`} legend={t('admin.pricing.form.occupancies')} hint={t('admin.pricing.form.occupanciesHint')} options={[1, 2, 3, 4].map((n) => ({ value: n, label: t('admin.pricing.form.occupancyOption', { count: n }) }))} selected={form.occupancies} onChange={(v) => set('occupancies', v)} />
        <CheckGroup id={`${id}-types`} legend={t('admin.pricing.form.participationTypes')} hint={t('admin.pricing.form.participationTypesHint')} options={PARTICIPATION_TYPES.map((p) => ({ value: p as string, label: t(`admin.catalogue.participation.${p}`) }))} selected={form.participationTypes} onChange={(v) => set('participationTypes', v)} />
      </fieldset>

      <fieldset className="stack">
        <legend>{t('admin.pricing.form.validity')}</legend>
        <p className="field__hint">{t('admin.pricing.form.validityHelp', { zone: zone() })}</p>
        <div className="inline-form">
          <TextField id={`${id}-from`} label={t('admin.pricing.form.validFrom')} type="datetime-local" value={form.validFrom} onChange={(v) => set('validFrom', v)} error={err('validFrom')} />
          <TextField id={`${id}-to`} label={t('admin.pricing.form.validTo')} type="datetime-local" value={form.validTo} onChange={(v) => set('validTo', v)} error={err('validTo')} />
        </div>
      </fieldset>

      {audience === 'promo' ? (
        <fieldset className="stack">
          <legend>{t('admin.pricing.form.limits')}</legend>
          {editing ? <p>{t('admin.pricing.form.redeemed', { count: String(row.redeemedCount ?? 0) })}</p> : null}
          <div className="inline-form">
            <TextField id={`${id}-max`} label={t('admin.pricing.form.maxRedemptions')} hint={t('admin.pricing.form.maxRedemptionsHint')} inputMode="numeric" value={form.maxRedemptions} onChange={(v) => set('maxRedemptions', v)} error={err('maxRedemptions')} />
            <TextField id={`${id}-percustomer`} label={t('admin.pricing.form.maxPerCustomer')} hint={t('admin.pricing.form.maxPerCustomerHint')} inputMode="numeric" value={form.maxPerCustomer} onChange={(v) => set('maxPerCustomer', v)} error={err('maxPerCustomer')} />
          </div>
        </fieldset>
      ) : null}

      <fieldset className="stack">
        <legend>{t('admin.pricing.form.behaviour')}</legend>
        {audience === 'rule' ? <TextField id={`${id}-priority`} label={t('admin.pricing.form.priority')} hint={t('admin.pricing.form.priorityHint')} inputMode="numeric" value={form.priority} onChange={(v) => set('priority', v)} error={err('priority')} /> : null}
        <CheckField id={`${id}-stackable`} label={t('admin.pricing.form.stackable')} hint={t('admin.pricing.form.stackableHint')} checked={form.stackable} onChange={(v) => set('stackable', v)} />
        <CheckField id={`${id}-enabled`} label={t('admin.pricing.form.enabled')} hint={t('admin.pricing.form.enabledHint')} checked={form.enabled} onChange={(v) => set('enabled', v)} />
      </fieldset>

      <TextField id={`${id}-reason`} label={t('admin.common.reason')} maxLength={500} value={reason} onChange={setReason} />
      {errors.size > 0 ? <p className="form-error" role="alert">{t('admin.pricing.editor.fixErrors', { count: errors.size })}</p> : null}
      <div className="actions">
        <button className="btn" type="submit" disabled={runner.busy}>
          {t(editing ? 'admin.pricing.form.save' : `admin.pricing.form.${audience}.create`)}
        </button>
        {onCancel ? (
          <button type="button" className="link-button" onClick={onCancel}>
            {t('admin.pricing.form.cancel')}
          </button>
        ) : null}
      </div>
      {info ? <p role="status" className="notice">{info}</p> : null}
      {runner.status}
      {isVersionConflict(runner.failure) ? (
        <button type="button" className="link-button" onClick={() => void (onReload ?? onSaved)()}>
          {t('admin.pricing.common.reload')}
        </button>
      ) : null}
    </form>
  );
}

function scopeText(f: AdjustmentForm, editions: ScopeOption[], packages: ScopeOption[]): string {
  if (f.scopeType === 'global') return t('admin.pricing.scopes.globalLong');
  const list = f.scopeType === 'package' ? packages : editions;
  return list.find((o) => o.value === f.scopeId)?.label ?? t(`admin.pricing.scopes.${f.scopeType}Unknown`);
}
