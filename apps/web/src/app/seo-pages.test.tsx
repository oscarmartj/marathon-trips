import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RacePage, { generateMetadata as raceMetadata } from './[locale]/races/[slug]/page';
import { generateMetadata as racesMetadata } from './[locale]/races/page';
import RaceImage from './[locale]/races/[slug]/opengraph-image';
import RootImage from './opengraph-image';
import robots from './robots';
import sitemap from './sitemap';
import { publicRoutes } from '@/lib/routes';
import { detail, SLUG, stubCatalogue, summary } from '@/test/catalogue-fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('sitemap', () => {
  it('lists the fixed public pages and every race the public API returns, once each, with absolute addresses', async () => {
    stubCatalogue({ search: { items: [summary(), summary({ slug: 'second-race' })], page: 1, pageSize: 50, total: 2 } });
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.every((u) => /^https?:\/\//.test(u))).toBe(true);
    expect(urls).toContain(`http://localhost:3000/races/${SLUG}`);
    expect(urls).toContain('http://localhost:3000/races/second-race');
    expect(urls).toContain('http://localhost:3000/');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('reads every page of the catalogue', async () => {
    const calls = stubCatalogue({ search: { items: [summary()], page: 1, pageSize: 50, total: 120 } });
    await sitemap();
    expect(calls.filter((c) => c.includes('/catalogue/races?')).length).toBeGreaterThan(1);
  });

  it('has no draft or demo race, no package builder page, no admin, account, checkout or token page', async () => {
    // Draft and demo races are never returned by the public API (1.1, 1.5), so the sitemap, which reads only that API, cannot list them.
    stubCatalogue({ search: { items: [summary()], page: 1, pageSize: 50, total: 1 } });
    const urls = (await sitemap()).map((e) => new URL(e.url).pathname);
    expect(urls.some((p) => p.includes('/build') || p.includes('demo'))).toBe(false);
    for (const banned of ['/admin', '/account', '/checkout', '/alerts']) expect(urls.some((p) => p.startsWith(banned))).toBe(false);
    for (const p of urls.filter((p) => !p.startsWith('/races/'))) expect(publicRoutes.map((r) => r.path)).toContain(p);
  });

  it('fails, rather than publishing a sitemap with no races, when the catalogue is down', async () => {
    stubCatalogue({ status: 500 });
    await expect(sitemap()).rejects.toThrow();
  });
});

describe('robots', () => {
  it('points at the sitemap and keeps crawlers out of the admin panel, API proxy and customer pages', () => {
    const r = robots();
    expect(r.sitemap).toBe('http://localhost:3000/sitemap.xml');
    const rules = Array.isArray(r.rules) ? r.rules[0]! : r.rules;
    expect(rules.disallow).toEqual(expect.arrayContaining(['/admin', '/api/', '/account', '/checkout']));
  });
});

describe('race page', () => {
  const html = async (race = detail()) => {
    stubCatalogue({ race });
    return renderToStaticMarkup(await RacePage({ params: Promise.resolve({ slug: SLUG }) }));
  };
  const ld = (page: string) => [...page.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].flatMap((m) => JSON.parse(m[1]!.replace(/\\u003c/g, '<')) as Array<{ '@type': string }>);

  it('carries a breadcrumb and an event for a confirmed edition', async () => {
    const types = ld(await html()).map((d) => d['@type']);
    expect(types).toEqual(['BreadcrumbList', 'SportsEvent']);
  });

  it('carries no event while the date is unconfirmed', async () => {
    const race = detail();
    race.editions = [{ ...race.editions[0]!, dateConfirmed: false, dateStatus: 'provisional' }];
    expect(ld(await html(race)).map((d) => d['@type'])).toEqual(['BreadcrumbList']);
  });

  it('has a title, description, canonical address and Open Graph data', async () => {
    stubCatalogue();
    const m = await raceMetadata({ params: Promise.resolve({ slug: SLUG }) });
    expect(m.title).toBe('Sample Marathon');
    expect(m.description).toContain('flat road course');
    expect(m.alternates?.canonical).toBe(`http://localhost:3000/races/${SLUG}`);
    expect(m.openGraph).toMatchObject({ url: `http://localhost:3000/races/${SLUG}` });
  });

  it('asks not to be indexed when the race does not exist', async () => {
    stubCatalogue({ race: null });
    const m = await raceMetadata({ params: Promise.resolve({ slug: 'nope' }) });
    expect(m.robots).toMatchObject({ index: false });
  });
});

describe('race finder metadata', () => {
  it('is indexable plain, and noindex with a canonical of /races once filtered or paged', async () => {
    const plain = await racesMetadata({ searchParams: Promise.resolve({}) });
    expect(plain.robots).toBeUndefined();
    const filtered = await racesMetadata({ searchParams: Promise.resolve({ month: '5' }) });
    expect(filtered.robots).toMatchObject({ index: false });
    expect(filtered.alternates?.canonical).toBe('http://localhost:3000/races');
  });
});

describe('share images', () => {
  it('renders a PNG for the site and for a race, and falls back to the site image for an unknown race', async () => {
    stubCatalogue();
    for (const res of [RootImage(), await RaceImage({ params: Promise.resolve({ slug: SLUG }) })]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
    stubCatalogue({ race: null });
    expect((await RaceImage({ params: Promise.resolve({ slug: 'nope' }) })).status).toBe(200);
  });
});
