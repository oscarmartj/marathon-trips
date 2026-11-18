import type { Prisma } from '../../generated/prisma/client';
import { unprocessable } from '../../platform/http/api-error';
import type { FormatDefinition } from './formats';
import { EXPORT_BOOKING_STATUSES, MAX_EXPORT_RUNNERS } from './manifest';
import { SOURCES, type Need, type Runner } from './sources';

type Tx = Prisma.TransactionClient;

export interface RunnerRow {
  reference: string;
  slot: number;
  runner: Runner;
}

export interface LoadedRunners {
  rows: RunnerRow[];
  /** Places whose traveller was erased: not exported, not listed. */
  erased: number;
}

const ERASED_MARKER = '[redacted]';

const enAu = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const pick = o['en-AU'] ?? o.en ?? Object.values(o).find((x) => typeof x === 'string');
    if (typeof pick === 'string') return pick;
  }
  return null;
};

/** The groups of data this format asks for; the query selects nothing else. */
export const needsOf = (format: FormatDefinition): Set<Need> => new Set(format.columns.map((c) => SOURCES[c.source].needs));

/**
 * Reads the runners of one edition for one format. Data minimisation is structural: the select is built from the
 * format's columns, so a format that does not ask for date of birth never loads it. Supporters never match (the filter
 * is on the format's runner types, which can only be runner types), places removed by an amendment are left out, and a
 * traveller that was erased, or whose customer was, is counted and left out.
 */
export async function loadRunners(tx: Tx, format: FormatDefinition, edition: { id: string }, raceDistanceId?: string): Promise<LoadedRunners> {
  const needs = needsOf(format);
  const places = await tx.bookingTraveller.findMany({
    where: {
      participationType: { in: [...format.participation] },
      removedInVersion: null,
      ...(raceDistanceId ? { raceDistanceId } : {}),
      booking: { editionId: edition.id, status: { in: [...EXPORT_BOOKING_STATUSES] } },
    },
    select: {
      bookingId: true,
      slot: true,
      booking: { select: { reference: true, customer: { select: { anonymisedAt: true, deletedAt: true } }, ...(needs.has('country') ? { residenceCountry: true } : {}) } },
      ...(needs.has('distance') ? { raceDistance: { select: { name: true, distanceMetres: true } } } : {}),
    },
    orderBy: [{ booking: { reference: 'asc' } }, { slot: 'asc' }],
    take: MAX_EXPORT_RUNNERS + 1,
  });
  if (places.length > MAX_EXPORT_RUNNERS) throw unprocessable('too_many_runners', 'This edition has too many runners for one file. Filter by distance.');
  if (places.length === 0) return { rows: [], erased: 0 };

  const travellers = await tx.traveller.findMany({
    // Only the places being exported: no supporter, removed place or own-entry runner is loaded.
    where: { OR: places.map((p) => ({ bookingId: p.bookingId, slot: p.slot })) },
    select: {
      bookingId: true,
      slot: true,
      anonymisedAt: true,
      ...(needs.has('name') ? { givenName: true, familyName: true } : {}),
      ...(needs.has('dateOfBirth') ? { dateOfBirth: true } : {}),
      ...(needs.has('finishTime') ? { estimatedFinishSeconds: true } : {}),
      ...(needs.has('emergencyContact') ? { emergencyContactName: true, emergencyContactPhone: true } : {}),
    },
  });
  const byPlace = new Map(travellers.map((t) => [`${t.bookingId}:${t.slot}`, t]));

  const rows: RunnerRow[] = [];
  let erased = 0;
  for (const p of places) {
    const t = byPlace.get(`${p.bookingId}:${p.slot}`) as Record<string, unknown> | undefined;
    const names = [t?.givenName, t?.familyName];
    if (p.booking.customer.anonymisedAt || p.booking.customer.deletedAt || t?.anonymisedAt || names.includes(ERASED_MARKER)) {
      erased++;
      continue;
    }
    const dob = t?.dateOfBirth instanceof Date ? t.dateOfBirth.toISOString().slice(0, 10) : null;
    const dist = 'raceDistance' in p ? (p.raceDistance as { name: unknown; distanceMetres: number } | null) : null;
    rows.push({
      reference: p.booking.reference,
      slot: p.slot,
      runner: {
        givenName: (t?.givenName as string | undefined) ?? null,
        familyName: (t?.familyName as string | undefined) ?? null,
        dateOfBirth: dob,
        estimatedFinishSeconds: (t?.estimatedFinishSeconds as number | null | undefined) ?? null,
        emergencyContactName: (t?.emergencyContactName as string | null | undefined) ?? null,
        emergencyContactPhone: (t?.emergencyContactPhone as string | null | undefined) ?? null,
        distanceName: dist ? enAu(dist.name) : null,
        distanceMetres: dist ? dist.distanceMetres : null,
        countryOfResidence: 'residenceCountry' in p.booking ? ((p.booking as { residenceCountry: string }).residenceCountry ?? null) : null,
      },
    });
  }
  return { rows, erased };
}
