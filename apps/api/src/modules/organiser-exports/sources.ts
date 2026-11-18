// The closed list of what an organiser export can ever contain (task 7.2, plan section 2). A format column names one of
// these keys; nothing else about a runner is reachable from a format, so a field that is not here cannot be exported.

/** A runner as the exporter holds it: exactly these fields, nothing else is read from the database. */
export interface Runner {
  givenName: string | null;
  familyName: string | null;
  /** YYYY-MM-DD */
  dateOfBirth: string | null;
  estimatedFinishSeconds: number | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  distanceName: string | null;
  distanceMetres: number | null;
  /** ISO 3166-1 alpha-2, the country the booking customer declared; null once erased. */
  countryOfResidence: string | null;
}

/** Groups of columns the reader may select. A format that has no source needing a group never loads it. */
export type Need = 'name' | 'dateOfBirth' | 'finishTime' | 'emergencyContact' | 'distance' | 'country';

export type SourceType = 'text' | 'date' | 'duration' | 'country' | 'distance';

/** How a typed value may be written, per source type. */
export const AS_OPTIONS: Readonly<Record<SourceType, readonly string[]>> = {
  text: [],
  date: ['iso', 'dmy', 'mdy'],
  duration: ['hms', 'minutes'],
  country: ['name', 'alpha2'],
  distance: ['name', 'km'],
};

export interface SourceDef {
  type: SourceType;
  needs: Need;
  raw(r: Runner): string | number | null;
}

export const SOURCES = Object.freeze({
  givenName: { type: 'text', needs: 'name', raw: (r) => r.givenName },
  familyName: { type: 'text', needs: 'name', raw: (r) => r.familyName },
  dateOfBirth: { type: 'date', needs: 'dateOfBirth', raw: (r) => r.dateOfBirth },
  estimatedFinishTime: { type: 'duration', needs: 'finishTime', raw: (r) => r.estimatedFinishSeconds },
  emergencyContactName: { type: 'text', needs: 'emergencyContact', raw: (r) => r.emergencyContactName },
  emergencyContactPhone: { type: 'text', needs: 'emergencyContact', raw: (r) => r.emergencyContactPhone },
  distance: { type: 'distance', needs: 'distance', raw: (r) => (r.distanceName !== null || r.distanceMetres !== null ? 'present' : null) },
  countryOfResidence: { type: 'country', needs: 'country', raw: (r) => r.countryOfResidence },
} as const satisfies Record<string, SourceDef>);
for (const d of Object.values(SOURCES)) Object.freeze(d);

export type SourceKey = keyof typeof SOURCES;
export const SOURCE_KEYS = Object.keys(SOURCES) as SourceKey[];

const regionNames = new Intl.DisplayNames(['en-AU'], { type: 'region' });

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function writeDate(iso: string, as: string): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return as === 'dmy' ? `${d}/${m}/${y}` : as === 'mdy' ? `${m}/${d}/${y}` : iso;
}

function writeDuration(seconds: number, as: string): string {
  if (as === 'minutes') return String(Math.round(seconds / 60));
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** Kilometres as plain decimal text with no trailing zeros: 42195 m is "42.195", 10000 m is "10". */
function writeKm(metres: number): string {
  return String(metres / 1000);
}

/** One cell as text, or '' when there is no value. The database has no distance name here: the reader passes the en-AU name. */
export function writeValue(def: SourceDef, r: Runner, as: string | undefined): string {
  const v = def.raw(r);
  if (v === null || v === '') return '';
  switch (def.type) {
    case 'text': return String(v).trim();
    case 'date': return writeDate(String(v), as ?? 'iso');
    case 'duration': return writeDuration(Number(v), as ?? 'hms');
    case 'country': {
      const code = String(v);
      if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') return '';
      return as === 'alpha2' ? code : (regionNames.of(code) ?? '');
    }
    case 'distance':
      return as === 'km' ? (r.distanceMetres === null ? '' : writeKm(r.distanceMetres)) : String(r.distanceName ?? '');
  }
}
