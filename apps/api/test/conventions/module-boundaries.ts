// Finds writes to another module's tables (plan 3.1: "no other module uses Prisma on its tables to write").
// Text-based on purpose, like the schema parser: it needs no TypeScript or Prisma internals.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSchema } from './schema-conventions';

const WRITES = 'create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany';

export interface SourceFile {
  /** Path relative to apps/api/src, with forward slashes. */
  name: string;
  text: string;
}

export function readSources(srcDir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'generated') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push({ name: relative(srcDir, p).split('\\').join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(srcDir);
  return out;
}

/** module name -> { models, tables }, from prisma/schema/<module>.prisma for every folder in src/modules. */
export function modelsByModule(schemaDir: string, moduleNames: string[]): Record<string, { models: string[]; tables: string[] }> {
  const result: Record<string, { models: string[]; tables: string[] }> = {};
  for (const name of moduleNames) {
    let text: string;
    try {
      text = readFileSync(join(schemaDir, `${name}.prisma`), 'utf8');
    } catch {
      continue;
    }
    const models = parseSchema([{ name: `${name}.prisma`, text }]);
    result[name] = { models: models.map((m) => m.name), tables: models.map((m) => m.table) };
  }
  return result;
}

const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One message per write that a file outside the owning module makes to a table of that module. */
export function findCrossModuleWrites(files: SourceFile[], owners: Record<string, { models: string[]; tables: string[] }>): string[] {
  const errors: string[] = [];
  for (const f of files) {
    const mine = /^modules\/([^/]+)\//.exec(f.name)?.[1];
    for (const [owner, { models, tables }] of Object.entries(owners)) {
      if (owner === mine) continue;
      for (const model of models) {
        if (new RegExp(`\\.${camel(model)}\\.(${WRITES})\\b`).test(f.text)) errors.push(`${f.name}: writes ${model} (owned by ${owner}) with the Prisma client`);
      }
      for (const table of tables) {
        if (new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"?${table}"?\\b`, 'i').test(f.text)) errors.push(`${f.name}: writes table ${table} (owned by ${owner}) with SQL`);
      }
    }
  }
  return errors;
}
