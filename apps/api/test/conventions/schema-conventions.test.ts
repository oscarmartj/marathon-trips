import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkConventions } from './schema-conventions';

const prismaDir = join(__dirname, '../../prisma');
const schemaFiles = readdirSync(join(prismaDir, 'schema'))
  .filter((f) => f.endsWith('.prisma'))
  .map((f) => ({ name: f, text: readFileSync(join(prismaDir, 'schema', f), 'utf8') }));
const migrationsSql = readdirSync(join(prismaDir, 'migrations'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => readFileSync(join(prismaDir, 'migrations', d.name, 'migration.sql'), 'utf8'))
  .join('\n');

const one = (text: string, sql = '') => checkConventions([{ name: 'fixture.prisma', text }], sql);

describe('real schema', () => {
  it('follows every convention', () => {
    expect(checkConventions(schemaFiles, migrationsSql)).toEqual([]);
  });
  it('has one .prisma file per module, with base.prisma holding the generator', () => {
    expect(schemaFiles.map((f) => f.name)).toContain('base.prisma');
    expect(schemaFiles.filter((f) => /^\s*generator\s/m.test(f.text)).map((f) => f.name)).toEqual(['base.prisma']);
  });
});

// Each row is a schema that breaks exactly one convention; the checker must say so.
const cases: Array<[string, string, string, RegExp]> = [
  ['float_rejected', 'model A {\n id String @id @db.Uuid\n x Float\n}', '', /Float is not allowed/],
  ['decimal_rejected', 'model A {\n id String @id @db.Uuid\n x Decimal\n}', '', /Decimal is not allowed/],
  ['minor_not_bigint', 'model A {\n id String @id @db.Uuid\n totalMinor Int\n currency String @db.Char(3) /// @nopii code\n}', 'CHECK ("totalMinor" >= 0)', /must be BigInt/],
  ['minor_without_currency', 'model A {\n id String @id @db.Uuid\n totalMinor BigInt\n}', 'CHECK ("totalMinor" >= 0)', /no paired currency/],
  ['minor_optional_currency_on_required_amount', 'model A {\n id String @id @db.Uuid\n totalMinor BigInt\n currency String? /// @nopii code\n}', 'CHECK ("totalMinor" >= 0)', /optional currency/],
  ['minor_without_sign_check', 'model A {\n id String @id @db.Uuid\n totalMinor BigInt\n currency String /// @nopii code\n}', '', /no sign CHECK/],
  ['bps_not_int', 'model A {\n id String @id @db.Uuid\n depositBps BigInt\n}', '', /must be Int/],
  ['text_without_annotation', 'model A {\n id String @id @db.Uuid\n title String\n}', '', /needs \/\/\/ @pii/],
  ['json_without_annotation', 'model A {\n id String @id @db.Uuid\n extra Json\n}', '', /needs \/\/\/ @pii/],
  ['hash_without_secret', 'model A {\n id String @id @db.Uuid\n passwordHash String /// @nopii oops\n}', '', /needs \/\/\/ @secret/],
  ['relation_without_restrict', 'model P {\n id String @id @db.Uuid\n cs C[]\n}\nmodel C {\n id String @id @db.Uuid\n pId String @db.Uuid\n p P @relation(fields: [pId], references: [id])\n}', '', /onDelete: Restrict/],
  ['relation_cascade', 'model P {\n id String @id @db.Uuid\n cs C[]\n}\nmodel C {\n id String @id @db.Uuid\n pId String @db.Uuid\n p P @relation(fields: [pId], references: [id], onDelete: Cascade, onUpdate: Restrict)\n}', '', /onDelete: Restrict/],
  ['composite_fk_without_unique', 'model P {\n id String @id @db.Uuid\n cur String @db.Char(3) /// @nopii code\n cs C[]\n}\nmodel C {\n id String @id @db.Uuid\n pId String @db.Uuid\n cur String @db.Char(3) /// @nopii code\n p P @relation(fields: [pId, cur], references: [id, cur], onDelete: Restrict, onUpdate: Restrict)\n}', '', /composite foreign key/],
  ['sql_cascade', 'model A {\n id String @id @db.Uuid\n}', 'ALTER TABLE x ADD FOREIGN KEY (a) REFERENCES y(id) ON DELETE CASCADE;', /CASCADE/],
  ['append_only_without_trigger', '/// @appendOnly\nmodel A {\n id String @id @db.Uuid\n @@map("as")\n}', '', /without an UPDATE\/DELETE trigger/],
  ['append_only_without_truncate_trigger', '/// @appendOnly\nmodel A {\n id String @id @db.Uuid\n @@map("as")\n}', 'CREATE TRIGGER t BEFORE UPDATE OR DELETE ON "as"', /without a TRUNCATE trigger/],
  ['append_only_fk_to_deletable_row', 'model P {\n id String @id @db.Uuid\n cs A[]\n}\n/// @appendOnly\nmodel A {\n id String @id @db.Uuid\n pId String @db.Uuid\n p P @relation(fields: [pId], references: [id], onDelete: Restrict, onUpdate: Restrict)\n @@map("as")\n}', 'CREATE TRIGGER t BEFORE UPDATE OR DELETE ON "as"\nCREATE TRIGGER u BEFORE TRUNCATE ON "as"', /never deleted/],
  ['sql_set_null', 'model A {\n id String @id @db.Uuid\n}', 'ALTER TABLE x ADD FOREIGN KEY (a) REFERENCES y(id) ON UPDATE SET NULL;', /SET NULL/],
];

describe('convention checker (fixtures that must fail)', () => {
  it.each(cases)('%s', (_name, schema, sql, expected) => {
    expect(one(schema, sql).join('\n')).toMatch(expected);
  });
});

const good: Array<[string, string, string]> = [
  ['annotated_money_row', 'model A {\n id String @id @db.Uuid\n totalMinor BigInt\n currency String /// @nopii code\n}', 'CHECK ("totalMinor" >= 0)'],
  ['signed_amount_needs_no_check', 'model A {\n id String @id @db.Uuid\n /// @signed\n amountMinor BigInt\n currency String /// @nopii code\n}', ''],
  ['declared_fk_exception', 'model P {\n id String @id @db.Uuid\n cs C[]\n}\nmodel C {\n id String @id @db.Uuid\n pId String @db.Uuid\n /// @fkException child is purged with its parent by design\n p P @relation(fields: [pId], references: [id], onDelete: Cascade, onUpdate: Restrict)\n}', ''],
  ['composite_fk_with_unique', 'model P {\n id String @id @db.Uuid\n cur String @db.Char(3) /// @nopii code\n cs C[]\n @@unique([id, cur])\n}\nmodel C {\n id String @id @db.Uuid\n pId String @db.Uuid\n cur String @db.Char(3) /// @nopii code\n p P @relation(fields: [pId, cur], references: [id, cur], onDelete: Restrict, onUpdate: Restrict)\n}', ''],
  ['append_only_with_triggers', '/// @appendOnly\nmodel A {\n id String @id @db.Uuid\n @@map("as")\n}', 'CREATE TRIGGER t BEFORE UPDATE OR DELETE ON "as"\nCREATE TRIGGER u BEFORE TRUNCATE ON "as"'],
  ['sql_exception_comment', 'model A {\n id String @id @db.Uuid\n}', 'ALTER TABLE x ADD FOREIGN KEY (a) REFERENCES y(id) ON DELETE CASCADE; -- @fkException purge by design'],
];

describe('convention checker (fixtures that must pass)', () => {
  it.each(good)('%s', (_name, schema, sql) => {
    expect(one(schema, sql)).toEqual([]);
  });
});
