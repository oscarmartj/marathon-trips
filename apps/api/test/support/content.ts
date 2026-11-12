import { CONTENT_PERMISSIONS } from '../../src/modules/content';
import { TestApp } from './auth';
import { CATALOGUE_AND_PRICING, Client, buildWorld, slug, staffClient } from './catalogue';

export const CP = CONTENT_PERMISSIONS;
export const ALL_CONTENT_PERMISSIONS = Object.values(CONTENT_PERMISSIONS);
/** Catalogue permissions are needed to build the published race a guide points at. */
export const ALL = [...ALL_CONTENT_PERMISSIONS, ...CATALOGUE_AND_PRICING];

export const contentAdmin = (t: TestApp, permissions: string[] = ALL) => staffClient(t, permissions);

export const must = <T extends { status: number; body: unknown }>(r: T, what: string): T => {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

export const pageBody = (over: Record<string, unknown> = {}) => ({ slug: slug('page'), title: 'About us', body: 'First paragraph.\n\nSecond paragraph.', ...over });

/** Creates and publishes in one go; returns the published row. */
export async function published(admin: Client, kind: string, body: Record<string, unknown>) {
  const row = must(await admin.post(`/admin/content/${kind}`, body), `create ${kind}`).body;
  return must(await admin.post(`/admin/content/${kind}/${row.id}/status`, { status: 'published', version: row.version }), `publish ${kind}`).body;
}

/** A published race (the catalogue's world with the race published), so its guide can be public. */
export async function publishedRace(admin: Client) {
  const w = await buildWorld(admin);
  must(await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version }), 'publish race');
  return w.race;
}
