import { SUPPLIERS_PERMISSIONS } from '../../src/modules/suppliers';
import { FeatureFlagService } from '../../src/platform/flags/flags.service';
import { TestApp } from './auth';
import { CATALOGUE_AND_PRICING, Client, World, buildWorld, staffClient } from './catalogue';

export const SP = SUPPLIERS_PERMISSIONS;
export const ALL_SUPPLIER_PERMISSIONS = Object.values(SUPPLIERS_PERMISSIONS);
/** Catalogue and pricing permissions are needed to build the edition and pools the allotments point at. */
export const ALL = [...ALL_SUPPLIER_PERMISSIONS, ...CATALOGUE_AND_PRICING];

export async function setSuppliersFlag(t: TestApp, enabled: boolean): Promise<void> {
  const flags = t.app.get(FeatureFlagService);
  await flags.ensure('module.suppliers', enabled);
  await t.prisma.featureFlag.update({ where: { key: 'module.suppliers' }, data: { enabled } });
}

export const adminWith = (t: TestApp, permissions: string[] = ALL) => staffClient(t, permissions);

export const must = <T extends { status: number; body: unknown }>(r: T, what: string): T => {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

export const supplierBody = (over: Record<string, unknown> = {}) => ({ kind: 'hotel', name: 'Harbour Hotel', countryCode: 'DK', defaultCurrency: 'DKK', ...over });

/** A supplier with one contract for the world's edition. */
export async function supplierWithContract(admin: Client, w: World, over: { contract?: Record<string, unknown> } = {}) {
  const supplier = must(await admin.post('/admin/suppliers', supplierBody()), 'create supplier').body;
  const contract = must(await admin.post(`/admin/suppliers/${supplier.id}/contracts`, { reference: `C-${Math.random().toString(36).slice(2, 8)}`, editionId: w.edition.id, ...over.contract }), 'create contract').body;
  return { supplier, contract };
}

export { buildWorld };
