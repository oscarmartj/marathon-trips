'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import { tierLine } from '@/lib/cancellation';
import { bpsToText, parseMoney, parsePercent } from '@/lib/pricing-panel';
import { t } from '@/lib/i18n';
import { Section, useLoad } from '../catalogue/kit';
import { isVersionConflict, useRunner } from './pricing-kit';

// The same list as the shared schema (not imported: the main entry of @mt/shared carries zod, which the browser must not download).
const CANCELLATION_PENALTY_MODES = ['percent', 'fixed_per_person', 'fixed_per_booking'] as const;
type Mode = (typeof CANCELLATION_PENALTY_MODES)[number];
interface TierRow { minDaysBeforeDeparture: number; penaltyMode: Mode; penaltyBps: number | null; penaltyMinor: string | null; currency: string | null }
interface PolicyListItem { id: string; name: string; status: string; currency: string | null; version: number; packages: number; tiers: number }
interface PolicyDetail { id: string; name: string; status: 'draft' | 'active' | 'archived'; version: number; description: Record<string, string>; tiers: Array<TierRow & { id: string }>; packageIds: string[]; digest: string | null; problems: Array<{ code: string; tier?: number }> }

/** Cancellation policies (task 6.4): drafts are edited; activating freezes one; a package then sells under it. */
export function CancellationPoliciesList() {
  const { data, reload } = useLoad<{ items: PolicyListItem[] }>('/admin/pricing/cancellation-policies');
  const runner = useRunner();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  async function create() {
    const r = await runner.run(() => api('/admin/pricing/cancellation-policies', { method: 'POST', body: { name: name.trim(), description: { 'en-AU': description.trim() } } }), t('admin.pricing.cancellation.created'));
    if (r) {
      setName('');
      setDescription('');
      await reload();
    }
  }

  return (
    <div className="stack">
      <Section id="cancellation-policies" title={t('admin.pricing.cancellation.listTitle')}>
        {!data ? <p role="status">{t('admin.common.loading')}</p> : data.items.length === 0 ? <p>{t('admin.pricing.cancellation.none')}</p> : (
          <table className="table">
            <caption>{t('admin.pricing.cancellation.listCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.pricing.cancellation.name')}</th>
                <th scope="col">{t('admin.pricing.cancellation.status')}</th>
                <th scope="col">{t('admin.pricing.cancellation.tiersCount')}</th>
                <th scope="col">{t('admin.pricing.cancellation.packagesCount')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <th scope="row"><Link href={`/admin/cancellation-policies/${p.id}`}>{p.name}</Link></th>
                  <td>{t(`admin.pricing.cancellation.statuses.${p.status}`)}</td>
                  <td>{p.tiers}</td>
                  <td>{p.packages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section id="cancellation-policy-new" title={t('admin.pricing.cancellation.newTitle')}>
        <div className="field">
          <label htmlFor="policy-name">{t('admin.pricing.cancellation.name')}</label>
          <input id="policy-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="policy-description">{t('admin.pricing.cancellation.description')}</label>
          <textarea id="policy-description" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby="policy-description-hint" />
          <p id="policy-description-hint" className="field__hint">{t('admin.pricing.cancellation.descriptionHint')}</p>
        </div>
        <div className="actions">
          <button className="btn" type="button" disabled={runner.busy || !name.trim() || !description.trim()} onClick={() => void create()}>{t('admin.pricing.cancellation.create')}</button>
        </div>
        {runner.prompt}
        {runner.status}
      </Section>
    </div>
  );
}

/** One tier as a person edits it: days, the kind of penalty and its value as typed. */
interface EditRow { days: string; mode: Mode; value: string }
const toEdit = (r: TierRow): EditRow => ({ days: String(r.minDaysBeforeDeparture), mode: r.penaltyMode, value: r.penaltyMode === 'percent' ? bpsToText(r.penaltyBps ?? 0) : centsText(r.penaltyMinor ?? '0') });
const centsText = (minor: string): string => {
  const s = minor.padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};

/** Typed rows to the API's tiers, or the index of the first row that is not valid. */
function toTiers(rows: EditRow[]): { tiers: TierRow[] } | { bad: number } {
  const tiers: TierRow[] = [];
  for (const [i, r] of rows.entries()) {
    if (!/^\d{1,4}$/.test(r.days.trim())) return { bad: i };
    const days = Number(r.days.trim());
    if (r.mode === 'percent') {
      const bps = r.value.trim() === '0' ? 0 : parsePercent(r.value, 10_000);
      if (bps === null) return { bad: i };
      tiers.push({ minDaysBeforeDeparture: days, penaltyMode: 'percent', penaltyBps: bps, penaltyMinor: null, currency: null });
    } else {
      const m = parseMoney(r.value);
      if (!m.ok) return { bad: i };
      tiers.push({ minDaysBeforeDeparture: days, penaltyMode: r.mode, penaltyBps: null, penaltyMinor: m.minor, currency: 'AUD' });
    }
  }
  return { tiers };
}

export function CancellationPolicyEditor({ id }: { id: string }) {
  const { data: p, reload } = useLoad<PolicyDetail>(`/admin/pricing/cancellation-policies/${id}`);
  const runner = useRunner();
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [rowError, setRowError] = useState<number | null>(null);
  if (!p) return <p role="status">{t('admin.common.loading')}</p>;
  const editing = rows ?? p.tiers.map(toEdit);
  const draft = p.status === 'draft';
  const after = async (r: unknown) => {
    if (r) {
      setRows(null);
      await reload();
    } else if (isVersionConflict(runner.failure)) await reload();
  };
  const set = (i: number, patch: Partial<EditRow>) => setRows(editing.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function saveTiers() {
    const parsed = toTiers(editing);
    if ('bad' in parsed) {
      setRowError(parsed.bad);
      return;
    }
    setRowError(null);
    await after(await runner.run(() => api(`/admin/pricing/cancellation-policies/${id}/tiers`, { method: 'PUT', body: { version: p!.version, tiers: parsed.tiers } }), t('admin.pricing.cancellation.saved')));
  }
  const post = async (what: 'activate' | 'archive' | 'duplicate', ok: string) => {
    const r = await runner.run(() => api(`/admin/pricing/cancellation-policies/${id}/${what}`, { method: 'POST', body: what === 'duplicate' ? {} : { version: p!.version } }), ok);
    if (r && what === 'duplicate') window.location.assign(`/admin/cancellation-policies/${(r.body as { id: string }).id}`);
    else await after(r);
  };

  return (
    <div className="stack">
      <Section id="policy-summary" title={p.name}>
        <p>{t(`admin.pricing.cancellation.statuses.${p.status}`)}</p>
        {p.description['en-AU'] ? <p>{p.description['en-AU']}</p> : null}
        {p.packageIds.length > 0 ? <p>{t('admin.pricing.cancellation.usedBy', { count: String(p.packageIds.length) })}</p> : null}
      </Section>
      <Section id="policy-tiers" title={t('admin.pricing.cancellation.tiersTitle')}>
        <p className="field__hint">{t('admin.pricing.cancellation.tiersHint')}</p>
        {draft ? (
          <>
            {editing.map((r, i) => (
              <fieldset key={i} className="form" aria-invalid={rowError === i ? true : undefined}>
                <legend>{t('admin.pricing.cancellation.tierLegend', { n: String(i + 1) })}</legend>
                <div className="field">
                  <label htmlFor={`tier-days-${i}`}>{t('admin.pricing.cancellation.days')}</label>
                  <input id={`tier-days-${i}`} inputMode="numeric" value={r.days} onChange={(e) => set(i, { days: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`tier-mode-${i}`}>{t('admin.pricing.cancellation.mode')}</label>
                  <select id={`tier-mode-${i}`} value={r.mode} onChange={(e) => set(i, { mode: e.target.value as Mode })}>
                    {CANCELLATION_PENALTY_MODES.map((m) => <option key={m} value={m}>{t(`admin.pricing.cancellation.modes.${m}`)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`tier-value-${i}`}>{t(r.mode === 'percent' ? 'admin.pricing.cancellation.percent' : 'admin.pricing.cancellation.amount')}</label>
                  <input id={`tier-value-${i}`} inputMode="decimal" value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
                </div>
                {rowError === i ? <p className="form-error" role="alert">{t('admin.pricing.cancellation.rowInvalid')}</p> : null}
                <button className="link-button" type="button" onClick={() => setRows(editing.filter((_, j) => j !== i))}>{t('admin.pricing.cancellation.removeTier')}</button>
              </fieldset>
            ))}
            <div className="actions">
              <button className="link-button" type="button" disabled={editing.length >= 10} onClick={() => setRows([...editing, { days: '0', mode: 'percent', value: '100' }])}>{t('admin.pricing.cancellation.addTier')}</button>
              <button className="btn" type="button" disabled={runner.busy} onClick={() => void saveTiers()}>{t('admin.pricing.cancellation.saveTiers')}</button>
            </div>
            {p.problems.length > 0 ? <ul>{p.problems.map((x, i) => <li key={i}>{t(`admin.pricing.cancellation.problems.${x.code}`)}</li>)}</ul> : null}
            <div className="actions">
              <button className="btn" type="button" disabled={runner.busy || rows !== null || p.problems.length > 0} onClick={() => void post('activate', t('admin.pricing.cancellation.activated'))}>{t('admin.pricing.cancellation.activate')}</button>
            </div>
          </>
        ) : (
          <ul>
            {p.tiers.map((tier, i) => {
              const l = tierLine(tier, i > 0 ? p.tiers[i - 1]! : null);
              return <li key={tier.id}>{t(l.key, l.params)}</li>;
            })}
          </ul>
        )}
        <div className="actions">
          {p.status === 'active' ? <button className="link-button" type="button" disabled={runner.busy} onClick={() => void post('archive', t('admin.pricing.cancellation.archivedDone'))}>{t('admin.pricing.cancellation.archive')}</button> : null}
          <button className="link-button" type="button" disabled={runner.busy} onClick={() => void post('duplicate', t('admin.pricing.cancellation.created'))}>{t('admin.pricing.cancellation.duplicate')}</button>
        </div>
        {runner.prompt}
        {runner.status}
      </Section>
    </div>
  );
}

/** The policy a package sells under (task 6.4): new bookings keep it; existing ones keep theirs. */
export function PackageCancellationPolicy({ packageId }: { packageId: string }) {
  const current = useLoad<{ policyId: string | null; version: number | null }>(`/admin/pricing/packages/${packageId}/cancellation-policy`);
  const list = useLoad<{ items: PolicyListItem[] }>('/admin/pricing/cancellation-policies');
  const runner = useRunner();
  const [choice, setChoice] = useState<string | null>(null);
  if (!current.data || !list.data) return null;
  const active = list.data.items.filter((p) => p.status === 'active');
  const value = choice ?? current.data.policyId ?? '';

  async function save() {
    const r = await runner.run(() => api(`/admin/pricing/packages/${packageId}/cancellation-policy`, { method: 'PUT', body: { policyId: value || null, version: current.data!.version } }), t('admin.pricing.cancellation.assigned'));
    if (r || isVersionConflict(runner.failure)) {
      setChoice(null);
      await current.reload();
    }
  }

  return (
    <Section id="package-cancellation-policy" title={t('admin.pricing.cancellation.packageTitle')}>
      {current.data.policyId ? null : <p className="notice" role="status">{t('admin.pricing.cancellation.packageNone')}</p>}
      <div className="field">
        <label htmlFor="package-policy">{t('admin.pricing.cancellation.packagePolicy')}</label>
        <select id="package-policy" value={value} onChange={(e) => setChoice(e.target.value)} aria-describedby="package-policy-hint">
          <option value="">{t('admin.pricing.cancellation.packageNoneOption')}</option>
          {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p id="package-policy-hint" className="field__hint">{t('admin.pricing.cancellation.packageHint')}</p>
      </div>
      <div className="actions">
        <button className="btn" type="button" disabled={runner.busy || value === (current.data.policyId ?? '')} onClick={() => void save()}>{t('admin.pricing.cancellation.assign')}</button>
      </div>
      {runner.prompt}
      {runner.status}
    </Section>
  );
}
