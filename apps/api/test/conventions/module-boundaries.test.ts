import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { locate, violation } from '../../../../scripts/eslint-rules/module-boundaries.mjs';
import { findCrossModuleWrites, modelsByModule, readSources } from './module-boundaries';

const apiRoot = resolve(__dirname, '../..');
const repoRoot = resolve(apiRoot, '../..');
const src = join(apiRoot, 'src');
const f = (rel: string) => join(src, rel);

describe('module boundaries: imports (rule in scripts/eslint-rules/module-boundaries.mjs)', () => {
  it('locates files by area', () => {
    expect(locate(f('modules/catalogue/race.service.ts'))).toEqual({ area: 'module', name: 'catalogue' });
    expect(locate(f('platform/events/outbox.service.ts'))).toEqual({ area: 'platform' });
    expect(locate(f('app.module.ts'))).toBeNull();
  });

  it('a module may import another module only through its index', () => {
    const from = f('modules/pricing/engine.ts');
    expect(violation(from, '../catalogue')).toBeNull();
    expect(violation(from, '../catalogue/index')).toBeNull();
    expect(violation(from, '../catalogue/race.service')).toMatch(/public index of module "catalogue"/);
    expect(violation(from, '../catalogue/sub/deep')).toMatch(/public index/);
    expect(violation(from, './engine-helpers')).toBeNull();
    expect(violation(from, '../../platform/events/outbox.service')).toBeNull();
    expect(violation(from, '@mt/shared')).toBeNull();
    expect(violation(f('modules/catalogue/sub/a.ts'), '../race.service')).toBeNull();
  });

  it('platform code never imports from modules', () => {
    const from = f('platform/events/x.ts');
    expect(violation(from, '../../modules/catalogue')).toMatch(/platform code must not import from modules/);
    expect(violation(from, '../access/permissions')).toBeNull();
  });

  it('the repository ESLint configuration enforces it (fixtures must fail)', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const run = async (file: string, code: string) => (await eslint.lintText(code, { filePath: f(file) }))[0]!.messages.filter((m) => m.ruleId === 'mt/module-boundaries');
    expect(await run('modules/pricing/engine.ts', "import { x } from '../catalogue/race.service';\nexport const y = x;\n")).toHaveLength(1);
    expect(await run('modules/pricing/engine.ts', "export * from '../catalogue/transitions';\n")).toHaveLength(1);
    expect(await run('platform/events/x.ts', "import { CatalogueModule } from '../../modules/catalogue';\nexport const y = CatalogueModule;\n")).toHaveLength(1);
    expect(await run('modules/pricing/engine.ts', "import { InventoryService } from '../catalogue';\nexport const y = InventoryService;\n")).toHaveLength(0);
  });

  it('no module in the repository breaks the rule today', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles([join(src, '**/*.ts')]);
    const bad = results.flatMap((r) => r.messages.filter((m) => m.ruleId === 'mt/module-boundaries').map((m) => `${r.filePath}: ${m.message}`));
    expect(bad).toEqual([]);
  }, 60_000);
});

describe('module boundaries: writes to another module\'s tables', () => {
  const moduleNames = readdirSync(join(src, 'modules'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const owners = modelsByModule(join(apiRoot, 'prisma/schema'), moduleNames);

  it('every module has its own schema file', () => {
    expect(Object.keys(owners).sort()).toEqual(moduleNames.sort());
    expect(owners.catalogue!.models).toEqual(expect.arrayContaining(['Race', 'Package', 'InventoryPool']));
  });

  it('nothing outside a module writes to its tables', () => {
    expect(findCrossModuleWrites(readSources(src), owners)).toEqual([]);
  });

  it('fixtures that write must be found', () => {
    const bad = [
      { name: 'modules/pricing/engine.ts', text: 'await tx.race.update({ where: { id }, data: {} });' },
      { name: 'modules/pricing/engine.ts', text: 'await this.prisma.inventoryPool.updateMany({});' },
      { name: 'platform/x.ts', text: 'await tx.$executeRaw`UPDATE inventory_pools SET consumed = 0`;' },
      { name: 'modules/bookings/y.ts', text: 'await tx.$executeRawUnsafe(\'DELETE FROM "packages" WHERE true\');' },
    ];
    expect(findCrossModuleWrites(bad, owners)).toHaveLength(4);
    const fine = [
      { name: 'modules/pricing/engine.ts', text: 'const r = await tx.race.findMany(); const p = await tx.package.count();' },
      { name: 'modules/catalogue/inventory.service.ts', text: 'await tx.inventoryPool.update({});' },
    ];
    expect(findCrossModuleWrites(fine, owners)).toEqual([]);
  });
});
