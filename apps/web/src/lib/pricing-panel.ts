import { MAX_FIXED_PER_PERSON_MINOR, MAX_LINE_MINOR, MAX_QUOTE_TRAVELLERS, PARTICIPATION_TYPES } from '@mt/shared';
import { minorToDollars, wholeNumber } from './catalogue-panel';
import { isoToLocal, localToIso, resolveOffset, sameInstant, type Offset } from './panel-time';

// Pure helpers for the pricing panel (task 2.2b, plan docs/plans/2.2b-pricing-panel.md). The API's engine is the only
// place a total is computed. Nothing here adds, multiplies or divides money: money moves between the text a person types
// and the string of integer minor units (cents) the API uses, by cutting strings. `pricing-panel.test.ts` checks that this
// file has no floating-point money calls.

export type ParticipationType = (typeof PARTICIPATION_TYPES)[number];
export type MoneyFailure = 'empty' | 'invalid' | 'decimals' | 'too_large';
export type MoneyResult = { ok: true; minor: string } | { ok: false; reason: MoneyFailure };

/**
 * What a person types for an amount, in dollars, to a string of cents. Accepts "12", "12.5", "12.50", "$1,234.50" and
 * "A$5"; refuses signs, exponents, a bare dot, more than two decimals and anything above `max` (default: the line limit).
 */
export function parseMoney(input: string, max: bigint = MAX_LINE_MINOR): MoneyResult {
  let s = input.trim().replace(/^A?\$\s*/i, '');
  if (s === '') return { ok: false, reason: 'empty' };
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return { ok: false, reason: 'invalid' };
    s = s.replaceAll(',', '');
  }
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, reason: 'invalid' };
  const decimals = m[2] ?? '';
  if (decimals.length > 2) return { ok: false, reason: 'decimals' };
  const minor = `${m[1]}${decimals.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  // A comparison, not arithmetic: the limit is a bigint and the text is whole digits.
  if (BigInt(minor) > max) return { ok: false, reason: 'too_large' };
  return { ok: true, minor };
}

const SYMBOLS: Record<string, string> = { AUD: 'A$' };

/** A string of cents from the API for people: "123450" to "A$1,234.50". Anything that is not digits is shown as it came. */
export function formatMinor(minor: string, currency = 'AUD'): string {
  if (!/^\d+$/.test(minor)) return minor;
  const digits = minor.replace(/^0+(?=\d)/, '').padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${SYMBOLS[currency] ?? `${currency} `}${whole}.${digits.slice(-2)}`;
}

/** A breakdown line's amount with its direction, as the API gave it: discounts read "-A$20.00". */
export const formatLineAmount = (direction: string, minor: string, currency = 'AUD'): string => `${direction === 'discount' ? '-' : ''}${formatMinor(minor, currency)}`;

/** "25" or "12.5" to basis points (2500, 1250), by cutting the text. Null when it is not a percentage in 0.01 to `maxBps`. */
export function parsePercent(input: string, maxBps: number): number | null {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bps = Number(`${m[1]}${(m[2] ?? '').padEnd(2, '0')}`);
  return bps >= 1 && bps <= maxBps ? bps : null;
}

/** Basis points as the text a person edits: 2500 to "25", 1250 to "12.5". */
export function bpsToText(bps: number): string {
  const s = String(bps).padStart(3, '0');
  const frac = s.slice(-2).replace(/0+$/, '');
  return frac === '' ? s.slice(0, -2) : `${s.slice(0, -2)}.${frac}`;
}

// ---- The rate editor ----

/** The part of a package the rate editor needs; the package screen's own view has these fields. */
export interface PackageForPrices {
  currency: string;
  maxExtraNightsBefore: number;
  maxExtraNightsAfter: number;
  participationOptions: Array<{ type: string; enabled: boolean }>;
  entryOptions: Array<{ raceDistance: { id: string; name: unknown } }>;
  hotels: Array<{ hotel: { name: string }; rooms: Array<{ id: string; name: unknown; minOccupancy: number; maxOccupancy: number }> }>;
  extras: Array<{ id: string; name: unknown; pricingUnit: string; mandatory: boolean }>;
}

export interface RatesJson {
  roomRates: Array<{ roomOptionId: string; occupancy: number; pricePerPersonMinor: string; extraNightPerPersonMinor: string }>;
  participationRates: Array<{ participationType: string; raceDistanceId: string | null; amountPerPersonMinor: string }>;
  extraRates: Array<{ extraId: string; amountMinor: string }>;
}

export interface MissingJson {
  kind: 'room' | 'extra_night' | 'participation' | 'extra';
  roomOptionId?: string;
  occupancy?: number;
  participationType?: string;
  raceDistanceId?: string | null;
  extraId?: string;
}

export type Cells = Record<string, string>;

export const roomCell = (roomId: string, occupancy: number, field: 'price' | 'night') => `room|${roomId}|${occupancy}|${field}`;
export const participationCell = (type: string, distanceId: string | null) => `part|${type}|${distanceId ?? '-'}`;
export const extraCell = (extraId: string) => `extra|${extraId}`;

/** The cell a missing-rate report points at, so the editor can mark it. */
export function missingCell(m: MissingJson): string {
  if (m.kind === 'room') return roomCell(m.roomOptionId!, m.occupancy!, 'price');
  if (m.kind === 'extra_night') return roomCell(m.roomOptionId!, m.occupancy!, 'night');
  if (m.kind === 'participation') return participationCell(m.participationType!, m.raceDistanceId ?? null);
  return extraCell(m.extraId!);
}

/** The rows of the editor, from the package: what can be priced. */
export interface RateShape {
  rooms: Array<{ id: string; hotel: string; minOccupancy: number; maxOccupancy: number }>;
  participation: Array<{ type: string; distanceIds: Array<string | null> }>;
  extraIds: string[];
  offersExtraNights: boolean;
}

export function rateShapeOf(pkg: PackageForPrices): RateShape {
  const enabled = new Set(pkg.participationOptions.filter((o) => o.enabled).map((o) => o.type));
  return {
    rooms: pkg.hotels.flatMap((h) => h.rooms.map((r) => ({ id: r.id, hotel: h.hotel.name, minOccupancy: r.minOccupancy, maxOccupancy: r.maxOccupancy }))),
    participation: PARTICIPATION_TYPES.filter((p) => enabled.has(p)).map((type) => ({
      type,
      distanceIds: type === 'runner_with_entry' ? [...new Set(pkg.entryOptions.map((e) => e.raceDistance.id))] : [null],
    })),
    extraIds: pkg.extras.map((e) => e.id),
    offersExtraNights: pkg.maxExtraNightsBefore + pkg.maxExtraNightsAfter > 0,
  };
}

/** A version's rates as the text of the editor's cells (dollars with two decimals). */
export function ratesToCells(rates: RatesJson): Cells {
  const cells: Cells = {};
  for (const r of rates.roomRates) {
    cells[roomCell(r.roomOptionId, r.occupancy, 'price')] = minorToDollars(r.pricePerPersonMinor);
    cells[roomCell(r.roomOptionId, r.occupancy, 'night')] = minorToDollars(r.extraNightPerPersonMinor);
  }
  for (const r of rates.participationRates) cells[participationCell(r.participationType, r.raceDistanceId)] = minorToDollars(r.amountPerPersonMinor);
  for (const r of rates.extraRates) cells[extraCell(r.extraId)] = minorToDollars(r.amountMinor);
  return cells;
}

/** How many saved rates price something the package no longer has; saving the editor removes them. */
export function droppedRateCount(rates: RatesJson, shape: RateShape): number {
  const rooms = new Set(shape.rooms.map((r) => r.id));
  const parts = new Set(shape.participation.flatMap((p) => p.distanceIds.map((d) => participationCell(p.type, d))));
  const extras = new Set(shape.extraIds);
  return (
    rates.roomRates.filter((r) => !rooms.has(r.roomOptionId)).length
    + rates.participationRates.filter((r) => !parts.has(participationCell(r.participationType, r.raceDistanceId))).length
    + rates.extraRates.filter((r) => !extras.has(r.extraId)).length
  );
}

export type CellFailure = MoneyFailure | 'price_needed';
export type SetRatesBody = {
  version: number;
  roomRates: Array<{ roomOptionId: string; occupancy: number; pricePerPersonMinor: string; extraNightPerPersonMinor: string }>;
  participationRates: Array<{ participationType: string; raceDistanceId: string | null; amountPerPersonMinor: string }>;
  extraRates: Array<{ extraId: string; amountMinor: string }>;
  reason?: string;
};
export type BodyResult = { ok: true; body: SetRatesBody } | { ok: false; errors: Array<{ cell: string; reason: CellFailure }> };

/**
 * The PUT body for a draft's rates from the editor's cells. An empty cell is no rate. A room price without an
 * extra-night price sends 0 (the API then reports the extra night as missing when the package offers extra nights).
 * Cells for rooms, kinds or extras that the package does not have are left out.
 */
export function cellsToBody(cells: Cells, shape: RateShape, version: number, reason?: string): BodyResult {
  const errors: Array<{ cell: string; reason: CellFailure }> = [];
  const money = (cell: string): string | null => {
    const text = cells[cell];
    if (text === undefined || text.trim() === '') return null;
    const r = parseMoney(text);
    if (r.ok) return r.minor;
    errors.push({ cell, reason: r.reason });
    return null;
  };
  const body: SetRatesBody = { version, roomRates: [], participationRates: [], extraRates: [] };
  for (const room of shape.rooms) {
    for (let occupancy = 1; occupancy <= 4; occupancy++) {
      const priceCell = roomCell(room.id, occupancy, 'price');
      const nightCell = roomCell(room.id, occupancy, 'night');
      const price = money(priceCell);
      const night = money(nightCell);
      if (price === null && night === null) continue;
      if (price === null) {
        if (!errors.some((e) => e.cell === priceCell)) errors.push({ cell: priceCell, reason: 'price_needed' });
        continue;
      }
      body.roomRates.push({ roomOptionId: room.id, occupancy, pricePerPersonMinor: price, extraNightPerPersonMinor: night ?? '0' });
    }
  }
  for (const group of shape.participation) {
    for (const distanceId of group.distanceIds) {
      const amount = money(participationCell(group.type, distanceId));
      if (amount !== null) body.participationRates.push({ participationType: group.type, raceDistanceId: distanceId, amountPerPersonMinor: amount });
    }
  }
  for (const extraId of shape.extraIds) {
    const amount = money(extraCell(extraId));
    if (amount !== null) body.extraRates.push({ extraId, amountMinor: amount });
  }
  if (reason && reason.trim()) body.reason = reason.trim();
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body };
}

/** True when the editor's cells differ from the saved ones (empty and missing count the same). */
export function cellsDiffer(a: Cells, b: Cells): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? '').trim() !== (b[k] ?? '').trim()) return true;
  return false;
}

// ---- The quote preview ----

export interface QuoteFormState {
  priceVersionId: string;
  rooms: Array<{ roomOptionId: string; travellers: Array<{ participationType: string; raceDistanceId: string }> }>;
  extraNightsBefore: string;
  extraNightsAfter: string;
  /** Only the extras that are ticked. Per-person ones name the travellers (1-based slots); per-booking ones a quantity. */
  extras: Array<{ extraId: string; slots: number[]; quantity: string }>;
  promoCode: string;
}

export interface QuoteExtraKinds {
  (extraId: string): string | undefined;
}

/** The count of travellers in the form: how many slots a per-person extra can name. A count, not money. */
export const travellerCount = (f: Pick<QuoteFormState, 'rooms'>): number => f.rooms.reduce((n, r) => n + r.travellers.length, 0);

/**
 * The admin quote request for a form: a configuration, never an amount. Per-person extras send traveller slots,
 * per-booking ones a quantity (the engine refuses the other way round).
 */
export function toQuoteRequest(packageId: string, f: QuoteFormState, unitOf: QuoteExtraKinds) {
  const nights = (text: string) => wholeNumber(text) ?? 0;
  return {
    packageId,
    ...(f.priceVersionId ? { priceVersionId: f.priceVersionId } : {}),
    rooms: f.rooms.map((r) => ({
      roomOptionId: r.roomOptionId,
      travellers: r.travellers.map((t) => ({ participationType: t.participationType, ...(t.participationType === 'runner_with_entry' && t.raceDistanceId ? { raceDistanceId: t.raceDistanceId } : {}) })),
    })),
    extraNightsBefore: nights(f.extraNightsBefore),
    extraNightsAfter: nights(f.extraNightsAfter),
    extras: f.extras.map((e) => (unitOf(e.extraId) === 'per_booking' ? { extraId: e.extraId, quantity: Math.max(1, wholeNumber(e.quantity) ?? 1) } : { extraId: e.extraId, travellerSlots: [...e.slots].sort((a, b) => a - b) })),
    ...(f.promoCode.trim() ? { promoCode: f.promoCode.trim() } : {}),
  };
}

// ---- Rules and promo codes ----

export const RULE_VALUE_MAX_BPS = { discount: 10_000, surcharge: 100_000 } as const;

export interface AdjustmentForm {
  label: string;
  kind: string;
  direction: string;
  priority: string;
  stackable: boolean;
  enabled: boolean;
  effectMode: string;
  value: string;
  per: string;
  appliesTo: string;
  validFrom: string;
  validTo: string;
  bookedOnOrBefore: string;
  minDaysBeforeCheckIn: string;
  maxDaysBeforeCheckIn: string;
  minTravellers: string;
  maxTravellers: string;
  occupancies: number[];
  participationTypes: string[];
  code: string;
  maxRedemptions: string;
  maxPerCustomer: string;
  scopeType: string;
  scopeId: string;
}

export const emptyAdjustmentForm = (): AdjustmentForm => ({
  label: '', kind: 'custom', direction: 'discount', priority: '100', stackable: false, enabled: true, effectMode: 'percent', value: '', per: 'booking', appliesTo: 'subtotal',
  validFrom: '', validTo: '', bookedOnOrBefore: '', minDaysBeforeCheckIn: '', maxDaysBeforeCheckIn: '', minTravellers: '', maxTravellers: '', occupancies: [], participationTypes: [],
  code: '', maxRedemptions: '', maxPerCustomer: '', scopeType: 'global', scopeId: '',
});

export type FormFailure = MoneyFailure | 'label' | 'value' | 'percent' | 'number' | 'date' | 'instant' | 'code' | 'scope' | 'priority';
export type AdjustmentResult = { ok: true; body: Record<string, unknown> } | { ok: false; errors: Array<{ field: string; reason: FormFailure }> };

type Opts = { audience: 'rule' | 'promo'; offsetMinutes: Offset };

/** A whole number within bounds from a text field; empty is fine and means "not set". */
function bounded(text: string, min: number, max: number): { ok: true; value: number | undefined } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined };
  const n = wholeNumber(text);
  return n === undefined || n < min || n > max ? { ok: false } : { ok: true, value: n };
}

/**
 * Everything the create or update API takes for a rule or code, from the form. The caller sends it whole on create and
 * through `adjustmentPatch` on update. Percentages go to basis points and dollars to cents by cutting text.
 */
export function adjustmentBody(f: AdjustmentForm, { audience, offsetMinutes }: Opts): AdjustmentResult {
  const errors: Array<{ field: string; reason: FormFailure }> = [];
  const bad = (field: string, reason: FormFailure) => void errors.push({ field, reason });
  const label = f.label.trim();
  if (label === '' || label.length > 80) bad('label', 'label');
  const direction = audience === 'promo' ? 'discount' : f.direction;
  const percent = f.effectMode === 'percent';
  let valueBps: number | null = null;
  let valueMinor: string | null = null;
  if (percent) {
    valueBps = parsePercent(f.value, RULE_VALUE_MAX_BPS[direction === 'surcharge' ? 'surcharge' : 'discount']);
    if (valueBps === null) bad('value', 'percent');
  } else {
    const r = parseMoney(f.value, f.per === 'person' ? MAX_FIXED_PER_PERSON_MINOR : MAX_LINE_MINOR);
    if (r.ok) valueMinor = r.minor;
    else bad('value', r.reason);
  }
  const instant = (field: 'validFrom' | 'validTo'): string | null => {
    if (f[field].trim() === '') return null;
    const iso = localToIso(f[field], resolveOffset(offsetMinutes, f[field]));
    if (iso === null) bad(field, 'instant');
    return iso;
  };
  const validFrom = instant('validFrom');
  const validTo = instant('validTo');
  const conditions: Record<string, unknown> = {};
  if (f.bookedOnOrBefore.trim() !== '') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.bookedOnOrBefore.trim())) conditions.bookedOnOrBefore = f.bookedOnOrBefore.trim();
    else bad('bookedOnOrBefore', 'date');
  }
  for (const [field, min, max] of [['minDaysBeforeCheckIn', 0, 3650], ['maxDaysBeforeCheckIn', 0, 3650], ['minTravellers', 1, MAX_QUOTE_TRAVELLERS], ['maxTravellers', 1, MAX_QUOTE_TRAVELLERS]] as const) {
    const r = bounded(f[field], min, max);
    if (!r.ok) bad(field, 'number');
    else if (r.value !== undefined) conditions[field] = r.value;
  }
  if (f.occupancies.length > 0) conditions.occupancies = [...f.occupancies].sort((a, b) => a - b);
  if (f.participationTypes.length > 0) conditions.participationTypes = PARTICIPATION_TYPES.filter((p) => f.participationTypes.includes(p));
  const body: Record<string, unknown> = {
    label,
    conditions,
    effectMode: f.effectMode,
    valueBps,
    valueMinor,
    currency: percent ? null : 'AUD',
    per: percent ? 'booking' : f.per,
    appliesTo: f.appliesTo,
    stackable: f.stackable,
    enabled: f.enabled,
    validFrom,
    validTo,
  };
  if (audience === 'rule') {
    body.kind = f.kind;
    body.direction = direction;
    const p = bounded(f.priority, 0, 1000);
    if (!p.ok || p.value === undefined) bad('priority', 'priority');
    else body.priority = p.value;
  } else {
    for (const field of ['maxRedemptions', 'maxPerCustomer'] as const) {
      const r = bounded(f[field], 1, field === 'maxRedemptions' ? 1_000_000 : 1000);
      if (!r.ok) bad(field, 'number');
      else body[field] = r.value ?? null;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body };
}

/** The scope and code fields only creation sends. */
export function creationFields(f: AdjustmentForm, audience: 'rule' | 'promo'): { ok: true; fields: Record<string, unknown> } | { ok: false; errors: Array<{ field: string; reason: FormFailure }> } {
  const errors: Array<{ field: string; reason: FormFailure }> = [];
  const fields: Record<string, unknown> = { scopeType: f.scopeType, editionId: null, packageId: null };
  if (f.scopeType === 'edition') fields.editionId = f.scopeId;
  if (f.scopeType === 'package') fields.packageId = f.scopeId;
  if (f.scopeType !== 'global' && f.scopeId === '') errors.push({ field: 'scopeId', reason: 'scope' });
  if (audience === 'promo') {
    const code = f.code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$/.test(code)) errors.push({ field: 'code', reason: 'code' });
    fields.code = code;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, fields };
}

const instantToLocal = (iso: unknown, offset: Offset): string => (typeof iso === 'string' ? isoToLocal(iso, resolveOffset(offset, iso)) : '');

/** The form for a stored rule or code (the API row), so editing starts from what is saved. */
export function rowToForm(row: Record<string, unknown>, offsetMinutes: Offset): AdjustmentForm {
  const c = (row.conditions ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '');
  const fixed = row.effectMode === 'fixed';
  return {
    ...emptyAdjustmentForm(),
    label: text(row.label), kind: text(row.kind) || 'custom', direction: text(row.direction) || 'discount', priority: text(row.priority) || '100',
    stackable: row.stackable === true, enabled: row.enabled === true, effectMode: text(row.effectMode) || 'percent',
    value: fixed ? minorToDollars(text(row.valueMinor) || '0') : typeof row.valueBps === 'number' ? bpsToText(row.valueBps) : '',
    per: text(row.per) || 'booking', appliesTo: text(row.appliesTo) || 'subtotal',
    validFrom: instantToLocal(row.validFrom, offsetMinutes), validTo: instantToLocal(row.validTo, offsetMinutes),
    bookedOnOrBefore: text(c.bookedOnOrBefore), minDaysBeforeCheckIn: text(c.minDaysBeforeCheckIn), maxDaysBeforeCheckIn: text(c.maxDaysBeforeCheckIn),
    minTravellers: text(c.minTravellers), maxTravellers: text(c.maxTravellers),
    occupancies: Array.isArray(c.occupancies) ? (c.occupancies as number[]) : [], participationTypes: Array.isArray(c.participationTypes) ? (c.participationTypes as string[]) : [],
    code: text(row.code), maxRedemptions: text(row.maxRedemptions), maxPerCustomer: text(row.maxPerCustomer),
    scopeType: text(row.scopeType) || 'global', scopeId: text(row.packageId) || text(row.editionId),
  };
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const INSTANT_FIELDS = new Set(['validFrom', 'validTo']);

/**
 * The PATCH body for an update: only the fields whose value differs from the stored row (the API keeps what is left out),
 * plus the row's version for the optimistic lock. Conditions go whole when any condition changed, since the API replaces them.
 */
export function adjustmentPatch(row: Record<string, unknown>, body: Record<string, unknown>, reason?: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(body)) {
    const prev = row[key] ?? null;
    const same = INSTANT_FIELDS.has(key)
      ? sameInstant(prev as string | null, next as string | null)
      : key === 'conditions' ? canonical(prev ?? {}) === canonical(next ?? {}) : (prev ?? null) === (next ?? null);
    if (!same) patch[key] = next;
  }
  patch.version = row.version;
  if (reason && reason.trim()) patch.reason = reason.trim();
  return patch;
}

/** True when a PATCH carries nothing but its version (and reason): there is nothing to save. */
export const patchIsEmpty = (patch: Record<string, unknown>): boolean => Object.keys(patch).every((k) => k === 'version' || k === 'reason');

// ---- Versions ----

export interface VersionRow {
  id: string;
  packageId: string;
  currency: string;
  status: 'draft' | 'published' | 'archived';
  version: number;
  label: string;
  validFrom: string | null;
  validTo: string | null;
  publishedAt: string | null;
  createdAt: string;
}
export interface VersionList {
  currentId: string | null;
  lastId: string | null;
  items: VersionRow[];
}
export interface VersionDetail extends VersionRow {
  rates: RatesJson;
  missing: MissingJson[];
}
export type VersionPhase = 'draft' | 'in_force' | 'scheduled' | 'past' | 'archived';

/**
 * Where a version stands, for its label. The API says which version is in force (`currentId`, read on the server's
 * clock); a published one that is not in force is scheduled if it starts later than `nowMs`, else it has ended.
 */
export function versionPhase(v: Pick<VersionRow, 'id' | 'status' | 'validFrom'>, currentId: string | null, nowMs: number): VersionPhase {
  if (v.status === 'draft') return 'draft';
  if (v.status === 'archived') return 'archived';
  if (v.id === currentId) return 'in_force';
  return v.validFrom !== null && Date.parse(v.validFrom) > nowMs ? 'scheduled' : 'past';
}
