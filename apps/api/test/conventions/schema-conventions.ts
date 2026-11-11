// Checks the Prisma schema and migrations against the conventions in plan 0.1 (sections 1, 4.7, 4.9, 5.10).
// A small text parser is used on purpose: it needs no Prisma internals, so it cannot break on a Prisma upgrade.

export interface Field {
  name: string;
  type: string; // without ? or []
  optional: boolean;
  list: boolean;
  attrs: string; // attribute text after the type
  doc: string; // all `///` lines attached to the field
  relation?: { fields: string[]; references: string[]; onDelete?: string; onUpdate?: string };
}
export interface Model {
  name: string;
  fields: Field[];
  uniques: string[][]; // @@unique and @@id column sets
  file: string;
}

const listOf = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

export function parseSchema(files: Array<{ name: string; text: string }>): Model[] {
  const models: Model[] = [];
  for (const file of files) {
    let current: Model | null = null;
    let inModel = false;
    let doc: string[] = [];
    for (const raw of file.text.split('\n')) {
      const line = raw.trim();
      const open = /^model\s+(\w+)\s*\{/.exec(line);
      if (open && !inModel) {
        current = { name: open[1]!, fields: [], uniques: [], file: file.name };
        inModel = true;
        doc = [];
        continue;
      }
      if (/^(enum|generator|datasource)\s+\w+\s*\{/.test(line)) {
        inModel = false;
        current = null;
        // enums and blocks are skipped; they close with a lone }
        continue;
      }
      if (line === '}') {
        if (inModel && current) models.push(current);
        inModel = false;
        current = null;
        doc = [];
        continue;
      }
      if (!inModel || !current) continue;
      if (line.startsWith('///')) {
        doc.push(line);
        continue;
      }
      if (!line || line.startsWith('//')) continue;
      const block = /^@@(unique|id)\(\s*\[([^\]]*)\]/.exec(line);
      if (block) {
        current.uniques.push(listOf(block[2]!));
        doc = [];
        continue;
      }
      if (line.startsWith('@@')) {
        doc = [];
        continue;
      }
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!f) continue;
      const [, name, type, list, optional, rest] = f;
      const trailing = /\/\/\/.*$/.exec(rest!)?.[0] ?? '';
      const attrs = rest!.replace(/\/\/\/.*$/, '').trim();
      const field: Field = {
        name: name!, type: type!, optional: !!optional, list: !!list, attrs,
        doc: [...doc, trailing].join(' '),
      };
      const rel = /@relation\(([^)]*)\)/.exec(attrs);
      if (rel) {
        const body = rel[1]!;
        const arr = (k: string) => {
          const m = new RegExp(`${k}:\\s*\\[([^\\]]*)\\]`).exec(body);
          return m ? listOf(m[1]!) : [];
        };
        const word = (k: string) => new RegExp(`${k}:\\s*(\\w+)`).exec(body)?.[1];
        field.relation = { fields: arr('fields'), references: arr('references'), onDelete: word('onDelete'), onUpdate: word('onUpdate') };
      }
      current.fields.push(field);
      if (/@id\b/.test(attrs) || /@unique\b/.test(attrs)) current.uniques.push([name!]);
      doc = [];
    }
  }
  return models;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Returns one message per violation; an empty array means the schema follows the conventions. */
export function checkConventions(
  files: Array<{ name: string; text: string }>,
  migrationsSql: string,
): string[] {
  const models = parseSchema(files);
  const byName = new Map(models.map((m) => [m.name, m]));
  const errors: string[] = [];
  const where = (m: Model, f: Field) => `${m.name}.${f.name} (${m.file})`;

  for (const m of models) {
    const fkScalars = new Set(m.fields.flatMap((f) => f.relation?.fields ?? []));
    const relationTypes = new Set(models.map((x) => x.name));
    for (const f of m.fields) {
      if (f.type === 'Float' || f.type === 'Decimal') errors.push(`${where(m, f)}: ${f.type} is not allowed (money is BigInt minor units)`);

      if (/Minor$/.test(f.name)) {
        if (f.type !== 'BigInt') errors.push(`${where(m, f)}: *Minor must be BigInt`);
        const paired = f.name.replace(/Minor$/, 'Currency');
        const currencyName = m.fields.some((x) => x.name === paired) ? paired : 'currency';
        if (!m.fields.some((x) => x.name === currencyName)) errors.push(`${where(m, f)}: no paired currency column (${paired} or currency)`);
        else {
          const cur = m.fields.find((x) => x.name === currencyName)!;
          if (!f.optional && cur.optional) errors.push(`${where(m, f)}: required amount with optional currency`);
        }
        if (!/@signed\b/.test(f.doc)) {
          const sign = new RegExp(`CHECK\\s*\\([^;]*"${f.name}"\\s*(>=|>)\\s*0`, 'i');
          if (!sign.test(migrationsSql)) errors.push(`${where(m, f)}: no sign CHECK in migrations and not marked /// @signed`);
        }
      }
      if (/Bps$/.test(f.name) && f.type !== 'Int') errors.push(`${where(m, f)}: *Bps must be Int`);

      const isKey = /@id\b/.test(f.attrs) || fkScalars.has(f.name) || /@db\.Uuid/.test(f.attrs);
      const textual = ['String', 'Json', 'Bytes'].includes(f.type);
      if (textual && !isKey && !f.relation && !relationTypes.has(f.type) && !/@(pii|nopii|secret)\b/.test(f.doc)) {
        errors.push(`${where(m, f)}: text, Json or Bytes column needs /// @pii, /// @nopii <reason> or /// @secret`);
      }
      if (/(Hash|Ciphertext|Token)$|Secret/.test(f.name) && !/@secret\b/.test(f.doc)) {
        errors.push(`${where(m, f)}: credential-like column needs /// @secret`);
      }

      if (f.relation && f.relation.fields.length > 0) {
        const exception = /@fkException\s+\S+/.test(f.doc);
        if (!exception && (f.relation.onDelete !== 'Restrict' || f.relation.onUpdate !== 'Restrict')) {
          errors.push(`${where(m, f)}: relation must declare onDelete: Restrict and onUpdate: Restrict (or /// @fkException <reason>)`);
        }
        if (f.relation.fields.length > 1) {
          const parent = byName.get(f.type);
          if (!parent || !parent.uniques.some((u) => sameSet(u, f.relation!.references))) {
            errors.push(`${where(m, f)}: composite foreign key without a matching @@unique/@@id on ${f.type}`);
          }
        }
      }
    }
  }

  // Raw SQL: no cascading or nulling foreign keys unless the statement carries `-- @fkException <reason>`.
  migrationsSql.split('\n').forEach((line, i) => {
    if (/ON\s+(DELETE|UPDATE)\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT)/i.test(line) && !/--\s*@fkException\s+\S+/.test(line)) {
      errors.push(`migration line ${i + 1}: CASCADE / SET NULL / SET DEFAULT without -- @fkException <reason>`);
    }
  });
  return errors;
}
