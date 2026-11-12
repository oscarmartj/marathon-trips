'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { formatInstant, localToIso, offsetAtLocal } from '@/lib/panel-time';
import { t } from '@/lib/i18n';
import type { VersionDetail, VersionList } from '@/lib/pricing-panel';
import { Section } from '../catalogue/kit';
import { type AsyncAction, TextField, isVersionConflict, useRunner } from './pricing-kit';

/**
 * Publishes a complete, saved draft now or at a later time. Publishing changes the prices of a package, so the API asks for
 * a fresh authenticator code. `replacesVersionId` is the last version of the timeline that was on screen: if someone published
 * since, the API says so (409) and nothing changes.
 */
export function PublishPanel({ version, list, blocked, onDone }: { version: VersionDetail; list: VersionList; blocked: 'unsaved' | 'incomplete' | null; onDone: AsyncAction }) {
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [start, setStart] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const runner = useRunner();
  const last = list.items.find((v) => v.id === list.lastId);
  const current = list.items.find((v) => v.id === list.currentId);

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    let validFrom: string | undefined;
    if (when === 'later') {
      const iso = localToIso(start, offsetAtLocal(start));
      if (iso === null || Date.parse(iso) <= Date.now()) {
        setStartError(t(iso === null ? 'admin.pricing.publish.startInvalid' : 'admin.pricing.publish.startPast'));
        return;
      }
      validFrom = iso;
    }
    setStartError(null);
    const body = { version: version.version, replacesVersionId: list.lastId, ...(validFrom ? { validFrom } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) };
    const r = await runner.run(() => api(`/admin/pricing/price-versions/${version.id}/publish`, { method: 'POST', body }));
    if (r) {
      setDone(validFrom ? t('admin.pricing.publish.scheduled', { when: formatInstant(validFrom) }) : t('admin.pricing.publish.published'));
      await onDone();
    }
  }

  return (
    <Section id="publish" title={t('admin.pricing.publish.title')}>
      {done ? <p role="status" className="notice">{done}</p> : null}
      <p>{t('admin.pricing.publish.help')}</p>
      {current ? <p>{t('admin.pricing.publish.endsCurrent', { label: current.label })}</p> : <p>{t('admin.pricing.publish.noCurrent')}</p>}
      {last && last.id !== current?.id ? <p className="notice" role="note">{t('admin.pricing.publish.afterScheduled', { label: last.label, when: formatInstant(last.validFrom) })}</p> : null}
      {blocked ? <p className="notice" role="note">{t(`admin.pricing.publish.blocked.${blocked}`)}</p> : null}
      {runner.prompt}
      <form className="form stack" onSubmit={publish}>
        <fieldset className="field">
          <legend>{t('admin.pricing.publish.whenLegend')}</legend>
          <label htmlFor="publish-now">
            <input id="publish-now" type="radio" name="publish-when" checked={when === 'now'} onChange={() => setWhen('now')} /> {t('admin.pricing.publish.now')}
          </label>
          <label htmlFor="publish-later">
            <input id="publish-later" type="radio" name="publish-when" checked={when === 'later'} onChange={() => setWhen('later')} /> {t('admin.pricing.publish.later')}
          </label>
        </fieldset>
        {when === 'later' ? (
          <TextField id="publish-start" label={t('admin.pricing.publish.startLabel')} hint={t('admin.pricing.publish.startHint')} type="datetime-local" required value={start} onChange={setStart} error={startError} />
        ) : null}
        <TextField id="publish-reason" label={t('admin.common.reason')} maxLength={500} value={reason} onChange={setReason} />
        <div className="actions">
          <button className="btn" type="submit" disabled={runner.busy || blocked !== null}>
            {t(when === 'now' ? 'admin.pricing.publish.button' : 'admin.pricing.publish.scheduleButton')}
          </button>
        </div>
        {runner.status}
        {isVersionConflict(runner.failure) ? (
          <button type="button" className="link-button" onClick={() => void onDone()}>
            {t('admin.pricing.common.reload')}
          </button>
        ) : null}
      </form>
    </Section>
  );
}
