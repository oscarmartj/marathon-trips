import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOTMENT_KINDS, COST_BASES, SUPPLIER_KINDS } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { t } from '@/lib/i18n';
import { catalogueError } from '../catalogue/kit';

const PARAMS = { label: 'x', kind: 'x', country: 'x', currency: 'x', quantity: 1, pool: 'x', date: 'x', left: 1, reference: 'x', from: 'x', to: 'x', name: 'x', cost: 'x', contract: 'x', amount: 'x', kinds: 'x', description: 'x', unit: 'x', total: 'x', status: 'x' };

describe('supplier panel copy', () => {
  it('every literal message key used by the supplier panel exists', () => {
    const keys = new Set<string>();
    const files = [...readdirSync(__dirname).filter((f) => f.endsWith('.tsx')).map((f) => join(__dirname, f)), join(__dirname, '../../../app/admin/(panel)/suppliers/page.tsx'), join(__dirname, '../../../app/admin/(panel)/suppliers/[id]/page.tsx')];
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'(admin\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThan(40);
    for (const k of keys) expect(() => t(k, PARAMS), k).not.toThrow();
  });

  it.each([
    ['kinds', SUPPLIER_KINDS], ['allotments.kinds', ALLOTMENT_KINDS], ['allotments.status', ['held', 'released']], ['costs.bases', COST_BASES], ['costs.status', ['planned', 'due', 'paid', 'cancelled']],
  ])('has a label for every %s value', (group, values) => {
    for (const v of values) expect(() => t(`admin.suppliers.${group}.${v}`, PARAMS), `${group}.${v}`).not.toThrow();
  });

  it('has wording for every supplier error code the API can return', () => {
    const codes = ['supplier_has_contracts', 'supplier_has_costs', 'contract_has_allotments', 'contract_has_costs', 'contract_reference_taken', 'pool_kind_not_allowed', 'pool_edition_mismatch', 'release_after_event', 'allotment_released', 'cost_not_editable', 'fixed_cost_quantity', 'contract_supplier_mismatch', 'contract_edition_mismatch', 'contract_dates_invalid'];
    for (const code of codes) expect(catalogueError({ status: 409, body: { code } }), code).not.toBe(t('admin.common.error'));
  });

  it('never works out an amount in the browser: it only formats and parses', () => {
    const src = readdirSync(__dirname).filter((f) => f.endsWith('.tsx')).map((f) => readFileSync(join(__dirname, f), 'utf8')).join('\n');
    expect(src).not.toMatch(/\bquantity\s*\*|\*\s*(?:a|c)\.(?:quantity|unit)|reduce\(/);
  });
});
