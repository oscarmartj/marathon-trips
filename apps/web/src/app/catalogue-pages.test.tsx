import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Races from './(public)/races/page';
import RacePage from './(public)/races/[slug]/page';
import Home from './(public)/page';
import ConfirmPage from './(public)/alerts/confirm/page';
import UnsubscribePage from './(public)/alerts/unsubscribe/page';
import { detail, SLUG, stubCatalogue, summary } from '@/test/catalogue-fixtures';

afterEach(() => vi.unstubAllGlobals());

const races = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await Races({ searchParams: Promise.resolve(sp) }));
const race = async () => renderToStaticMarkup(await RacePage({ params: Promise.resolve({ slug: SLUG }) }));

describe('race finder', () => {
  it('passes combined filters to the API and keeps them selected in the form', async () => {
    const calls = stubCatalogue();
    const html = await races({ distance: 'half', month: '5', country: 'nz', type: 'road', q: 'rotorua', year: '2027' });
    const search = calls.find((c) => c.includes('q=rotorua'))!;
    for (const part of ['distance=half', 'month=5', 'country=NZ', 'type=road', 'year=2027']) expect(search).toContain(part);
    expect(html).toMatch(/<option value="half" selected/);
    expect(html).toMatch(/<option value="5" selected/);
    expect(html).toMatch(/<option value="NZ" selected/);
    expect(html).toMatch(/name="q"[^>]*value="rotorua"/);
  });

  it('is a plain GET form that works without JavaScript', async () => {
    stubCatalogue();
    expect(await races()).toMatch(/<form[^>]*action="\/races"[^>]*method="get"/);
  });

  it('shows a message when nothing matches and when the catalogue is down', async () => {
    stubCatalogue({ search: { items: [], page: 1, pageSize: 12, total: 0 } });
    expect(await races({ month: '2' })).toContain('No races match those filters');
    stubCatalogue({ status: 500 });
    expect(await races()).toContain('cannot be loaded right now');
  });

  it('links to the next page and keeps the filters', async () => {
    stubCatalogue({ search: { items: [summary()], page: 1, pageSize: 12, total: 30 } });
    expect(await races({ distance: 'half' })).toContain('href="/races?distance=half&amp;page=2"');
  });

  it('shows an unconfirmed date visibly on the card', async () => {
    const provisional = summary({ editions: [{ year: 2027, startDate: '2027-05-01', endDate: null, dateStatus: 'provisional', dateConfirmed: false, status: 'announced' }] });
    stubCatalogue({ search: { items: [provisional], page: 1, pageSize: 12, total: 1 } });
    expect(await races()).toContain('Date not yet confirmed');
    stubCatalogue();
    expect(await races()).not.toContain('Date not yet confirmed');
  });
});

describe('race page', () => {
  it('shows the guide, distances, editions and packages from the API', async () => {
    stubCatalogue();
    const html = await race();
    for (const text of ['A fast, flat road course', 'Marathon', 'Half marathon', '2027 edition', 'Classic weekend', 'Open for booking', 'Rotorua, New Zealand']) expect(html).toContain(text);
    expect(html).toContain('href="/races/sample-marathon/build?edition=2027&amp;package=classic"');
  });

  it('shows an unconfirmed date visibly', async () => {
    const d = detail();
    d.editions[0] = { ...d.editions[0]!, dateStatus: 'provisional', dateConfirmed: false };
    stubCatalogue({ race: d });
    expect(await race()).toContain('Date not yet confirmed');
  });

  it('shows no guaranteed-entry, partner or accreditation claim unless the API says so', async () => {
    stubCatalogue();
    expect(await race()).not.toMatch(/guaranteed entry|official partner|accredited/i);
    const d = detail({ claims: ['official_partner'] });
    d.editions[0]!.packages[0]!.guaranteedEntry = true;
    stubCatalogue({ race: d });
    const html = await race();
    expect(html).toContain('Guaranteed entry');
    expect(html).toContain('Official partner');
  });

  it('does not offer to build a package that is not open for booking', async () => {
    const d = detail();
    d.editions[0]!.packages[0]!.saleStatus = 'closed';
    stubCatalogue({ race: d });
    const html = await race();
    expect(html).toContain('Closed');
    expect(html).not.toContain('/build');
  });

  it('offers the waiting list, not a booking, for a package that is full (task 6.5)', async () => {
    for (const [status, label] of [['sold_out', 'Sold out'], ['waitlist', 'Waitlist only']] as const) {
      const d = detail();
      d.editions[0]!.packages[0]!.saleStatus = status;
      stubCatalogue({ race: d });
      const html = await race();
      expect(html).toContain(label);
      expect(html).toContain('Join the waiting list');
      expect(html).not.toContain('Build this package');
    }
  });

  it('says so when an edition has no packages on sale', async () => {
    const d = detail();
    d.editions[0]!.packages = [];
    stubCatalogue({ race: d });
    expect(await race()).toContain('No packages are on sale');
  });

  it('returns not found for an unknown race', async () => {
    stubCatalogue({ race: null });
    await expect(race()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });
});

describe('opening alerts', () => {
  it('offers the alert form when no package is open, and not when one is', async () => {
    const closed = detail();
    closed.editions[0]!.packages[0]!.saleStatus = 'coming_soon';
    stubCatalogue({ race: closed });
    const html = await race();
    expect(html).toContain('Be first to know when packages open');
    expect(html).toMatch(/<input[^>]*type="email"[^>]*required/);
    expect(html).toContain('Alert me');
    stubCatalogue();
    expect(await race()).not.toContain('Alert me');
  });

  it('offers the alert form for a race with no editions yet', async () => {
    const d = detail();
    d.editions = [];
    stubCatalogue({ race: d });
    expect(await race()).toContain('Alert me');
  });

  it('has confirm and unsubscribe pages that start in a neutral state and stay out of search results', () => {
    const confirm = renderToStaticMarkup(ConfirmPage());
    expect(confirm).toContain('Confirm your alert');
    expect(confirm).not.toContain('Confirm my alert'); // the button appears only once a token is found in the link
    expect(renderToStaticMarkup(UnsubscribePage())).toContain('Unsubscribing');
  });
});

describe('home page', () => {
  it('lists featured races and still renders when the catalogue is down', async () => {
    stubCatalogue();
    expect(renderToStaticMarkup(await Home())).toContain('Sample Marathon');
    stubCatalogue({ status: 500 });
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('Find a race');
    expect(html).not.toContain('Featured races');
  });
});

describe('no prices in the browser', () => {
  it('renders no price on the catalogue pages (prices belong to the pricing service)', async () => {
    stubCatalogue();
    expect(await race()).not.toMatch(/\$\s?\d|AUD\s?\d/);
    expect(await races()).not.toMatch(/\$\s?\d|AUD\s?\d/);
  });
});
