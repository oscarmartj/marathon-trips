import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notFound } from 'next/navigation';
import Build from './(public)/races/[slug]/build/page';
import { QuoteSummary } from '@/components/builder/quote-summary';
import { PackageBuilder } from '@/components/builder/package-builder';
import { defaultState } from '@/lib/builder';
import { breakdown } from '@/test/breakdown-fixture';
import { packageDetail, SLUG, stubCatalogue } from '@/test/catalogue-fixtures';

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }) }));
afterEach(() => vi.unstubAllGlobals());

const page = async (sp: Record<string, string | string[]> = { edition: '2027', package: 'classic' }) =>
  renderToStaticMarkup(await Build({ params: Promise.resolve({ slug: SLUG }), searchParams: Promise.resolve(sp) }));

describe('build page', () => {
  it('asks the catalogue API for the package named in the address and shows the builder', async () => {
    const calls = stubCatalogue();
    const html = await page();
    expect(calls.some((c) => c.endsWith('/catalogue/races/sample-marathon/editions/2027/packages/classic'))).toBe(true);
    for (const text of ['Classic weekend', 'Room 1', 'Twin room', 'Lakeside Hotel', 'Geothermal tour', 'Airport transfer', 'Included in every booking', 'Updating your price']) expect(html).toContain(text);
  });

  it('shows availability in words, not numbers', async () => {
    stubCatalogue();
    const html = await page();
    expect(html).toContain('Twin room (Limited availability)');
    expect(html).toContain('Single room (Sold out)');
    expect(html).toContain('Half marathon (Sold out)');
  });

  it('has a label for every select and input, and fieldsets with legends', async () => {
    stubCatalogue();
    const html = await page();
    const ids = [...html.matchAll(/<(?:select|input)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) expect(html).toContain(`for="${id}"`);
    expect(html).toMatch(/<legend>Room 1<\/legend>/);
    expect(html).toContain('aria-live="polite"');
  });

  it('reads the configuration from the address', async () => {
    stubCatalogue();
    const html = await page({ edition: '2027', package: 'classic', nb: '2', na: '1' });
    expect(html).toMatch(/<select id="nights-before"[^>]*>.*<option value="2" selected/);
    expect(html).toMatch(/<select id="nights-after"[^>]*>.*<option value="1" selected/);
  });

  it('is not found for a bad address or a package the API does not have', async () => {
    stubCatalogue({ pkg: null });
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND');
    stubCatalogue();
    await expect(page({ edition: 'abc', package: 'classic' })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(page({ edition: '2027', package: '../x' })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('offers no builder for a package that is not open', async () => {
    stubCatalogue({ pkg: packageDetail({ saleStatus: 'sold_out' }) });
    const html = await page();
    expect(html).toContain('This package is not open for booking');
    expect(html).not.toContain('Updating your price');
  });

  it('lets the API error propagate when the catalogue is down (Next shows its error page; nothing is cached)', async () => {
    stubCatalogue({ status: 500 });
    await expect(page()).rejects.toThrow(/Catalogue API answered 500/);
  });

  it('claims guaranteed entry only when the API says so', async () => {
    stubCatalogue();
    expect(await page()).not.toContain('Guaranteed entry');
    stubCatalogue({ pkg: packageDetail({ guaranteedEntry: true }) });
    expect(await page()).toContain('Guaranteed entry');
  });

  it('never says official partner or accredited', async () => {
    stubCatalogue();
    expect(await page()).not.toMatch(/official partner|accredited|guaranteed/i);
  });
});

describe('builder, no price until the API answers', () => {
  it('shows no total in its first render', () => {
    const pkg = packageDetail();
    const html = renderToStaticMarkup(<PackageBuilder pkg={pkg} initial={defaultState(pkg)} urlBase="?edition=2027&package=classic" />);
    expect(html).not.toContain('quote-total');
    expect(html).not.toMatch(/\$\d/);
  });
});

describe('quote summary, the API answer as sent', () => {
  const pkg = packageDetail();
  const html = (over = {}) => renderToStaticMarkup(<QuoteSummary pkg={pkg} breakdown={breakdown(over)} />);

  it('shows the total, deposit, balance and due date exactly as the API gave them', () => {
    const out = html();
    expect(out).toContain('data-testid="quote-total">$1,649.50<');
    expect(out).toContain('data-testid="quote-deposit">$500.00<');
    expect(out).toContain('data-testid="quote-balance">$1,149.50<');
    expect(out).toContain('Balance due by 1 March 2027');
  });

  it('shows a total that does not equal the sum of its lines (the web never reconciles, it only shows)', () => {
    const out = html({ totalMinor: '777700' });
    expect(out).toContain('$7,777.00');
    expect(out).not.toContain('$1,649.50</strong>');
  });

  it('lists every line with its own name and the discount as a negative', () => {
    const out = html();
    for (const text of ['Twin room', 'Runner with a race entry from us, Marathon', 'Geothermal tour', 'Discount', '-$100.00', '$1,200.00', '$450.00', '$99.50', 'Traveller 1']) expect(out).toContain(text);
  });

  it('shows full payment instead of a deposit when the API says payment is due in full', () => {
    const out = html({ fullPaymentDue: true });
    expect(out).toContain('payable in full');
    expect(out).not.toContain('quote-deposit');
  });

  it('shows a promo status as the API reports it, and nothing when there is none', () => {
    expect(html({ promo: { status: 'invalid' } })).toContain('That code can&#x27;t be applied to this booking.');
    expect(html({ promo: { status: 'none' } })).not.toContain('role="status"');
  });

  it('says a price does not hold places', () => {
    expect(html()).toContain('Showing a price does not hold your places');
  });

  it('copes with huge amounts without losing digits', () => {
    expect(html({ totalMinor: '999999999999' })).toContain('$9,999,999,999.99');
  });
});
