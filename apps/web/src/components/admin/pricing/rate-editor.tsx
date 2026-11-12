'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import {
  cellsDiffer, cellsToBody, droppedRateCount, extraCell, formatMinor, missingCell, parseMoney, participationCell, rateShapeOf, ratesToCells, roomCell,
  type CellFailure, type Cells, type VersionDetail,
} from '@/lib/pricing-panel';
import { t } from '@/lib/i18n';
import { Section } from '../catalogue/kit';
import { type AsyncAction, TextField, isVersionConflict, useRunner } from './pricing-kit';
import { describeMissing, namesOf } from './pricing-names';
import type { PricedPackage } from './pricing-types';

interface SetFlag {
  (value: boolean): void;
}
const cellId = (cell: string) => `cell-${cell.replace(/[^a-zA-Z0-9-]/g, '_')}`;

interface CellProps {
  cell: string;
  label: string;
  cells: Cells;
  editable: boolean;
  errors: Map<string, CellFailure>;
  onChange: (cell: string, text: string) => void;
}

/** One amount: a text box in dollars while editing, or the saved amount as text. Nothing is added or multiplied here. */
function RateCell({ cell, label, cells, editable, errors, onChange }: CellProps) {
  const text = cells[cell] ?? '';
  const failure = errors.get(cell);
  if (!editable) {
    const parsed = parseMoney(text);
    return <td>{parsed.ok ? formatMinor(parsed.minor) : t('admin.catalogue.common.notSet')}</td>;
  }
  const id = cellId(cell);
  return (
    <td>
      <input
        id={id} type="text" inputMode="decimal" autoComplete="off" value={text} aria-label={label} aria-invalid={failure ? true : undefined} aria-describedby={failure ? `${id}-error` : undefined}
        onChange={(e) => onChange(cell, e.target.value)}
      />
      {failure ? <span id={`${id}-error`} className="form-error">{t(`admin.pricing.cellErrors.${failure}`)}</span> : null}
    </td>
  );
}

/**
 * The rates of one version: rooms by occupancy, participation by kind of traveller and distance, and extras. Amounts are
 * typed in dollars and sent as cents (see `cellsToBody`). While the version is a draft the tables are inputs; otherwise they
 * are plain text. What the saved version still lacks comes from the API.
 */
export function RateEditor({ pkg, version, editable, onSaved, onReload, onDirty }: { pkg: PricedPackage; version: VersionDetail; editable: boolean; onSaved: AsyncAction; onReload: AsyncAction; onDirty: SetFlag }) {
  const shape = useMemo(() => rateShapeOf(pkg), [pkg]);
  const names = useMemo(() => namesOf(pkg), [pkg]);
  const saved = useMemo(() => (ratesToCells(version.rates)), [version]);
  const [cells, setCells] = useState<Cells>(saved);
  const [errors, setErrors] = useState<Map<string, CellFailure>>(new Map());
  const [reason, setReason] = useState('');
  const runner = useRunner();
  const [saving, setSaving] = useState(false);
  const dirty = editable && cellsDiffer(cells, saved);
  const missing = useMemo(() => (new Set(version.missing.map(missingCell))), [version]);
  const dropped = droppedRateCount(version.rates, shape);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // When the saved prices arrive after our own save, show them in the saved form ("250" becomes "250.00") unless there is more typing since.
  useEffect(() => setCells((prev) => (cellsDiffer(prev, saved) ? prev : saved)), [saved]);

  const change = (cell: string, text: string) => {
    setCells((prev) => ({ ...prev, [cell]: text }));
    setErrors((prev) => {
      if (!prev.has(cell)) return prev;
      const next = new Map(prev);
      next.delete(cell);
      return next;
    });
  };
  const props = { cells, editable, errors, onChange: change };
  const status = (rowCells: string[]) => (editable && rowCells.some((c) => (missing.has(c))) ? <span className="badge badge--warn">{t('admin.pricing.editor.needed')}</span> : null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const result = cellsToBody(cells, shape, version.version, reason);
    if (!result.ok) {
      setErrors(new Map(result.errors.map((x) => [x.cell, x.reason])));
      runner.clear();
      return;
    }
    setErrors(new Map());
    setSaving(true);
    const r = await runner.run(() => api(`/admin/pricing/price-versions/${version.id}/rates`, { method: 'PUT', body: result.body }), t('admin.pricing.editor.saved'));
    // The screen keeps what was typed; the new version number arrives with the reload, and saving again waits for it.
    if (r) {
      setReason('');
      await onSaved();
    }
    setSaving(false);
  }

  const errorCount = errors.size;
  return (
    <form onSubmit={save} className="stack" aria-label={t('admin.pricing.editor.formLabel')}>
      {runner.prompt}
      {editable ? <p>{t('admin.pricing.editor.help', { currency: version.currency })}</p> : null}
      {dropped > 0 && editable ? <p className="notice" role="note">{t('admin.pricing.editor.dropped', { count: dropped })}</p> : null}

      <Section id="rates-rooms" title={t('admin.pricing.editor.roomsTitle')}>
        {shape.rooms.length === 0 ? <p>{t('admin.pricing.editor.noRooms')}</p> : null}
        {shape.rooms.map((room) => (
          <div className="table-wrap" key={room.id}>
            <table className="table">
              <caption>{t('admin.pricing.editor.roomCaption', { room: names.room(room.id), hotel: room.hotel })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.pricing.editor.columns.occupancy')}</th>
                  <th scope="col">{t('admin.pricing.editor.columns.price', { currency: version.currency })}</th>
                  {shape.offersExtraNights ? <th scope="col">{t('admin.pricing.editor.columns.night', { currency: version.currency })}</th> : null}
                  {editable ? <th scope="col">{t('admin.pricing.editor.columns.status')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: room.maxOccupancy - room.minOccupancy + 1 }, (_v, i) => room.minOccupancy + i).map((occupancy) => {
                  const price = roomCell(room.id, occupancy, 'price');
                  const night = roomCell(room.id, occupancy, 'night');
                  const what = t('admin.pricing.editor.roomWhat', { room: names.room(room.id), count: occupancy });
                  return (
                    <tr key={occupancy}>
                      <th scope="row">{t('admin.pricing.editor.occupancy', { count: occupancy })}</th>
                      <RateCell cell={price} label={t('admin.pricing.editor.priceFor', { what })} {...props} />
                      {shape.offersExtraNights ? <RateCell cell={night} label={t('admin.pricing.editor.nightFor', { what })} {...props} /> : null}
                      {editable ? <td>{status([price, night])}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </Section>

      <Section id="rates-participation" title={t('admin.pricing.editor.participationTitle')}>
        <div className="table-wrap">
          <table className="table">
            <caption>{t('admin.pricing.editor.participationCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.pricing.editor.columns.traveller')}</th>
                <th scope="col">{t('admin.pricing.editor.columns.perPerson', { currency: version.currency })}</th>
                {editable ? <th scope="col">{t('admin.pricing.editor.columns.status')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {shape.participation.flatMap((group) =>
                group.distanceIds.map((distanceId) => {
                  const cell = participationCell(group.type, distanceId);
                  const what = names.participation(group.type, distanceId);
                  return (
                    <tr key={cell}>
                      <th scope="row">{what}</th>
                      <RateCell cell={cell} label={t('admin.pricing.editor.amountFor', { what })} {...props} />
                      {editable ? <td>{status([cell])}</td> : null}
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="rates-extras" title={t('admin.pricing.editor.extrasTitle')}>
        {shape.extraIds.length === 0 ? (
          <p>{t('admin.pricing.editor.noExtras')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption>{t('admin.pricing.editor.extrasCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.pricing.editor.columns.extra')}</th>
                  <th scope="col">{t('admin.pricing.editor.columns.unit')}</th>
                  <th scope="col">{t('admin.pricing.editor.columns.amount', { currency: version.currency })}</th>
                  {editable ? <th scope="col">{t('admin.pricing.editor.columns.status')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {shape.extraIds.map((id) => {
                  const cell = extraCell(id);
                  const unit = names.extraUnit(id);
                  return (
                    <tr key={id}>
                      <th scope="row">{names.extra(id)}</th>
                      <td>{unit ? t(`admin.catalogue.pricingUnits.${unit}`) : ''}</td>
                      <RateCell cell={cell} label={t('admin.pricing.editor.amountFor', { what: names.extra(id) })} {...props} />
                      {editable ? <td>{status([cell])}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {editable ? (
        <div className="stack">
          <TextField id="rates-reason" label={t('admin.common.reason')} maxLength={500} value={reason} onChange={setReason} />
          {errorCount > 0 ? <p className="form-error" role="alert">{t('admin.pricing.editor.fixErrors', { count: errorCount })}</p> : null}
          <div className="actions">
            <button className="btn" type="submit" disabled={runner.busy || saving || !dirty}>
              {t('admin.pricing.editor.save')}
            </button>
            {dirty ? <span role="status">{t('admin.pricing.editor.unsaved')}</span> : null}
          </div>
          {runner.status}
          {isVersionConflict(runner.failure) ? (
            <button type="button" className="link-button" onClick={() => void onReload()}>
              {t('admin.pricing.common.reload')}
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/** What this version still lacks to be published, in words, from the API's own report of the saved rates. */
export function Completeness({ pkg, version, dirty }: { pkg: PricedPackage; version: VersionDetail; dirty: boolean }) {
  const names = useMemo(() => (namesOf(pkg)), [pkg]);
  return (
    <Section id="completeness" title={t('admin.pricing.completeness.title')}>
      {version.missing.length === 0 ? (
        <p role="status">{t('admin.pricing.completeness.complete')}</p>
      ) : (
        <>
          <p>{t('admin.pricing.completeness.lacking', { count: version.missing.length })}</p>
          <ul>
            {version.missing.map((m, i) => (
              <li key={i}>{describeMissing(m, names)}</li>
            ))}
          </ul>
        </>
      )}
      {dirty ? <p className="notice" role="note">{t('admin.pricing.completeness.unsaved')}</p> : null}
    </Section>
  );
}
