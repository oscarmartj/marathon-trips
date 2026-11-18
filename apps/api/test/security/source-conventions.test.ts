import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 8.5: properties the security review checked by hand, kept from coming back by scanning the API source. Each scanner
// is also run on a planted bad example, so a test cannot pass because the scanner finds nothing at all.
const src = resolve(__dirname, '../../src');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'generated' ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const sources = files(src).map((p) => ({ file: relative(src, p), text: readFileSync(p, 'utf8') }));

/** `@Body()` with no pipe: the body must then be parsed by hand in that handler (S-review V2). */
export const unpipedBodies = (text: string): number => (text.match(/@Body\(\)/g) ?? []).length;
/** Raw SQL built from a string (not a tagged template): only where reviewed (V1, injection). */
export const unsafeSql = (text: string): number => (text.match(/\$(queryRawUnsafe|executeRawUnsafe)\s*[<(]/g) ?? []).length;
/** A Content-Disposition written by hand instead of through contentDisposition() (S-11). */
export const handWrittenDisposition = (text: string): boolean => /['"`]Content-Disposition['"`]\s*[,:]\s*[`'"]/i.test(text);
/** A log line that interpolates something that could hold personal data, a token or a raw error message (V16). */
export function leakyLogs(text: string): string[] {
  const calls = text.match(/(?:logger|console)\.(?:log|warn|error|debug|verbose)\([^;]*\);/g) ?? [];
  return calls.filter((c) => /\$\{[^}]*(\b(email|token|password|secret|body|headers)\b|\.message|\.stack|\breq\.|JSON\.stringify)[^}]*\}/i.test(c));
}

describe('scanners catch planted examples', () => {
  it('each scanner finds its bad example and passes a good one', () => {
    expect(unpipedBodies('create(@Body() body: unknown)')).toBe(1);
    expect(unpipedBodies('create(@Body(new ZodPipe(s)) b: B)')).toBe(0);
    expect(unsafeSql('await tx.$queryRawUnsafe(`SELECT ${x}`)')).toBe(1);
    expect(unsafeSql('await tx.$queryRaw`SELECT ${x}`')).toBe(0);
    expect(handWrittenDisposition("res.setHeader('Content-Disposition', `attachment; filename=\"${name}\"`)")).toBe(true);
    expect(handWrittenDisposition("res.setHeader('Content-Disposition', contentDisposition('attachment', name))")).toBe(false);
    expect(leakyLogs('this.logger.warn(`sign-in failed for ${email}`);')).toHaveLength(1);
    expect(leakyLogs('this.logger.error(`failed: ${err.message}`);')).toHaveLength(1);
    expect(leakyLogs('this.logger.error(`failed: ${safeError(err).code}`);')).toHaveLength(0);
  });
});

describe('API source conventions (task 8.5)', () => {
  it('a body without a validation pipe exists only where the handler parses it with a schema chosen by the route', () => {
    const found = sources.filter((s) => unpipedBodies(s.text) > 0).map((s) => `${s.file}:${unpipedBodies(s.text)}`);
    // content/admin.controller.ts: create and update pick the schema by :kind and call KINDS[kind].create/update.parse.
    expect(found).toEqual(['modules/content/admin.controller.ts:2']);
    expect(sources.find((s) => s.file === 'modules/content/admin.controller.ts')!.text.match(/KINDS\[k\]\.(create|update)\.parse\(/g)).toHaveLength(2);
  });

  it('raw SQL from a string appears only in the reviewed places, each with parameters for every value', () => {
    const found = Object.fromEntries(sources.filter((s) => unsafeSql(s.text) > 0).map((s) => [s.file, unsafeSql(s.text)]));
    // Reviewed in 8.5: values are $n parameters; the only interpolations are code-side constants (a column name from a
    // fixed map, a choice between two fixed predicates) or no interpolation at all.
    expect(found).toEqual({
      'modules/bookings/state-machine.ts': 1,
      'modules/bookings/amendment.service.ts': 1,
      'modules/bookings/read.ts': 2,
      'modules/privacy/export.service.ts': 1,
    });
  });

  it('Content-Disposition is only written through contentDisposition()', () => {
    expect(sources.filter((s) => handWrittenDisposition(s.text)).map((s) => s.file)).toEqual([]);
  });

  it('no log line interpolates an address, a token, a body, headers or a raw error message', () => {
    expect(sources.flatMap((s) => leakyLogs(s.text).map((c) => `${s.file}: ${c}`))).toEqual([]);
  });

  it('every CSV download goes through the formula-guarded writer', () => {
    const csvRoutes = sources.filter((s) => /Content-Type['"`]?\s*[,:]\s*['"`]text\/csv/i.test(s.text)).map((s) => s.file);
    expect(csvRoutes.length).toBeGreaterThan(0);
    const guarded = new Set(sources.filter((s) => /\b(toCsv|guardCell)\(/.test(s.text)).map((s) => s.file.split('/').slice(0, 2).join('/')));
    for (const f of csvRoutes) expect(guarded.has(f.split('/').slice(0, 2).join('/')), f).toBe(true);
  });
});

describe('contentDisposition (S-11)', () => {
  it('accepts plain download names and refuses anything that could break the header or carry a path', async () => {
    const { contentDisposition } = await import('../../src/platform/http/content-disposition');
    expect(contentDisposition('attachment', 'MT-ABC123-invoice.pdf')).toBe('attachment; filename="MT-ABC123-invoice.pdf"');
    for (const bad of ['a"b.csv', 'a\r\nSet-Cookie: x=1', '../etc/passwd', 'a/b.csv', '', '.hidden', 'x'.repeat(200), 'naïve.csv']) {
      expect(() => contentDisposition('attachment', bad), bad).toThrow();
    }
  });
});
