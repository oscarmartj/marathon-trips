import { AS_OPTIONS, SOURCES, type SourceKey } from './sources';

// Declarative organiser formats (task 7.2). A format is data: which columns, in which order, from which source, written
// how. The file is built only by walking `columns`, so what a format does not name is never written.

export type Participation = 'runner_with_entry' | 'runner_own_entry';

export interface ColumnDef {
  /** The header the organiser expects. */
  header: string;
  source: SourceKey;
  /** A runner without a value for this column blocks the export. */
  required: boolean;
  /** How the value is written; the options depend on the source type (AS_OPTIONS). */
  as?: string;
  /** More than this many characters blocks the export instead of being cut. */
  maxLength?: number;
}

export interface FormatDefinition {
  /** Lower-case slug used in requests and file names. */
  id: string;
  label: string;
  organiser: string;
  /** Absent = any race. */
  appliesTo: { raceSlugs?: readonly string[] };
  /** Never supporters. A format that does not say gets runners with an entry bought through us. */
  participation: readonly Participation[];
  file: { delimiter: ',' | ';'; bom: boolean; eol: '\r\n' | '\n' };
  columns: readonly ColumnDef[];
}

const ID = /^[a-z][a-z0-9_]{1,59}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** Checks a definition and freezes it. A bad definition throws, so it fails at start-up and never ships. */
export function defineFormat(def: FormatDefinition): FormatDefinition {
  const fail = (why: string): never => {
    throw new Error(`Organiser format "${def.id}": ${why}`);
  };
  if (!ID.test(def.id)) fail('the id is not a lower-case slug');
  if (def.columns.length === 0) fail('it has no columns');
  if (def.participation.length === 0) fail('it names no participation type');
  for (const p of def.participation) if (p !== 'runner_with_entry' && p !== 'runner_own_entry') fail(`participation "${String(p)}" is not a runner type`);
  if (def.file.delimiter !== ',' && def.file.delimiter !== ';') fail('the delimiter must be a comma or a semicolon');
  const seen = new Set<string>();
  for (const c of def.columns) {
    if (!c.header.trim() || c.header.length > 80 || CONTROL.test(c.header)) fail(`header "${c.header}" is empty, long or has control characters`);
    if (/^\s*[=+\-@]/.test(c.header)) fail(`header "${c.header}" starts like a spreadsheet formula`);
    if (seen.has(c.header)) fail(`header "${c.header}" is used twice`);
    seen.add(c.header);
    if (!Object.prototype.hasOwnProperty.call(SOURCES, c.source)) fail(`column "${c.header}" reads an unknown source "${String(c.source)}"`);
    const type = SOURCES[c.source].type;
    if (c.as !== undefined && !AS_OPTIONS[type].includes(c.as)) fail(`column "${c.header}": "${c.as}" is not a way to write a ${type}`);
    if (c.maxLength !== undefined && (!Number.isInteger(c.maxLength) || c.maxLength < 1)) fail(`column "${c.header}": bad maxLength`);
  }
  return deepFreeze(structuredClone(def));
}

/** Two sample formats. A real organiser's format is one more definition here (with `appliesTo.raceSlugs` when it is theirs alone). */
export const FORMATS: readonly FormatDefinition[] = Object.freeze([
  defineFormat({
    id: 'entry_list_basic', label: 'Entry list (basic)', organiser: 'Any organiser',
    appliesTo: {}, participation: ['runner_with_entry'],
    file: { delimiter: ',', bom: false, eol: '\r\n' },
    columns: [
      { header: 'Given name', source: 'givenName', required: true, maxLength: 100 },
      { header: 'Family name', source: 'familyName', required: true, maxLength: 100 },
      { header: 'Date of birth', source: 'dateOfBirth', required: true, as: 'iso' },
      { header: 'Distance', source: 'distance', required: true, as: 'name' },
    ],
  }),
  defineFormat({
    id: 'entry_list_international', label: 'Entry list (international, with emergency contact)', organiser: 'Any organiser',
    appliesTo: {}, participation: ['runner_with_entry'],
    file: { delimiter: ';', bom: true, eol: '\r\n' },
    columns: [
      { header: 'Surname', source: 'familyName', required: true, maxLength: 100 },
      { header: 'First name', source: 'givenName', required: true, maxLength: 100 },
      { header: 'Birth date', source: 'dateOfBirth', required: true, as: 'dmy' },
      { header: 'Country', source: 'countryOfResidence', required: true, as: 'name' },
      { header: 'Event (km)', source: 'distance', required: true, as: 'km' },
      { header: 'Expected finish (h:mm:ss)', source: 'estimatedFinishTime', required: false, as: 'hms' },
      { header: 'Emergency contact', source: 'emergencyContactName', required: false, maxLength: 100 },
      { header: 'Emergency phone', source: 'emergencyContactPhone', required: false, maxLength: 20 },
    ],
  }),
]);

/** The formats an edition's race can use: those with no race restriction and those that name its slug. */
export const formatsForRace = (raceSlug: string, formats: readonly FormatDefinition[] = FORMATS): FormatDefinition[] =>
  formats.filter((f) => !f.appliesTo.raceSlugs || f.appliesTo.raceSlugs.includes(raceSlug));
