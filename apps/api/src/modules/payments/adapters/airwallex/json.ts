// Exact JSON for the Airwallex adapter (plan docs/plans/9.2-airwallex.md, sections 5 and 19.6). Reading: every JSON
// number is kept as its source text (JSON.parse source text access, Node 22), so an amount never becomes a float on its
// way to bigint. Writing: a small serializer for plain values in which a DecimalLiteral is written as it is, unquoted.
import { DecimalLiteral } from './money';

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

/** Whether this runtime gives the reviver the number's source text. Checked once; without it nothing is parsed. */
export const SOURCE_TEXT_SUPPORTED: boolean = (() => {
  let ok = false;
  const reviver: Reviver = (_k, v, c) => {
    if (typeof v === 'number') ok = c?.source === '12.50';
    return v;
  };
  JSON.parse('12.50', reviver as Parameters<typeof JSON.parse>[1]);
  return ok;
})();

/** Parses JSON with every number as its source text. Throws on bad JSON or a runtime without source text access. */
export function parseExact(text: string): unknown {
  if (!SOURCE_TEXT_SUPPORTED) throw new Error('JSON source text access is not available');
  const reviver: Reviver = (_k, v, c) => (typeof v === 'number' ? (c?.source ?? null) : v);
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
}

/** What the serializer writes: plain objects, arrays, strings, booleans, small integers and decimal literals. */
export type JsonOut = string | boolean | number | DecimalLiteral | readonly JsonOut[] | { readonly [k: string]: JsonOut | undefined };

/** JSON text of `v`. A DecimalLiteral is written unquoted, exactly; a number must be a safe integer (never money). */
export function writeExact(v: JsonOut): string {
  if (v instanceof DecimalLiteral) return v.text;
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('only safe integers are written as numbers');
    return String(v);
  }
  if (Array.isArray(v)) return `[${(v as readonly JsonOut[]).map(writeExact).join(',')}]`;
  const o = v as { readonly [k: string]: JsonOut | undefined };
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${writeExact(o[k]!)}`).join(',')}}`;
}
