import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { proxy } from '@/proxy';
import { localisedText } from '@/lib/catalogue';
import { setRequestLocale } from '@/lib/locale-server';
import { resetRedirectCache } from '@/lib/redirects';
import { SLUG, contentPage, stubCatalogue, summary } from '@/test/catalogue-fixtures';
import LocaleLayout from './[locale]/layout';
import Home, { generateMetadata as homeMetadata } from './[locale]/page';
import FaqPage, { generateMetadata as faqMetadata } from './[locale]/faq/page';
import ContentPage, { generateMetadata as contentMetadata } from './[locale]/pages/[slug]/page';
import AboutPage, { generateMetadata as aboutMetadata } from './[locale]/about/page';
import RacePage, { generateMetadata as raceMetadata } from './[locale]/races/[slug]/page';
import sitemap from './sitemap';

const html = (el: unknown) => renderToStaticMarkup(el as never);
const params = <E extends Record<string, string> = Record<never, never>>(locale: string, extra: E = {} as E) => ({ params: Promise.resolve({ locale, ...extra }) });
const languagesOf = (m: { alternates?: unknown }) => (m.alternates as { languages?: Record<string, string> } | undefined)?.languages as Record<string, string>;

beforeEach(() => {
  process.env.ENABLED_LOCALES = 'es-ES';
});
afterEach(() => {
  delete process.env.ENABLED_LOCALES;
  setRequestLocale('en-AU');
  vi.unstubAllGlobals();
  resetRedirectCache();
});

describe('the page shell', () => {
  it('sets the document language from the address', async () => {
    const el = await LocaleLayout({ children: null, params: Promise.resolve({ locale: 'es-ES' }) });
    expect(el.props.lang).toBe('es-ES');
    const def = await LocaleLayout({ children: null, params: Promise.resolve({ locale: 'en-AU' }) });
    expect(def.props.lang).toBe('en-AU');
  });

  it('is a 404 for a language that is not enabled, and for one that does not exist', async () => {
    delete process.env.ENABLED_LOCALES;
    await expect(LocaleLayout({ children: null, params: Promise.resolve({ locale: 'es-ES' }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    await expect(LocaleLayout({ children: null, params: Promise.resolve({ locale: 'xx-XX' }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it('shows the language switcher only when there is more than one language, with each language named in itself', async () => {
    stubCatalogue({});
    setRequestLocale('es-ES');
    const out = html(await SiteHeader());
    expect(out).toContain('lang="es-ES"');
    expect(out).toContain('Español (España)');
    expect(out).toContain('English (Australia)');
    expect(out).toContain('aria-label="Idioma"');
    delete process.env.ENABLED_LOCALES;
    setRequestLocale('en-AU');
    expect(html(await SiteHeader())).not.toContain('language-switcher');
  });

  it('translates the built-in header and footer links and keeps the language in their addresses', async () => {
    stubCatalogue({});
    setRequestLocale('es-ES');
    const header = html(await SiteHeader());
    expect(header).toContain('href="/es-ES/races"');
    expect(header).toContain('>Carreras<');
    expect(header).toContain('href="/es-ES"'); // the logo
    const footer = html(await SiteFooter());
    expect(footer).toContain('Política de privacidad');
    expect(footer).toContain('href="/es-ES/legal/privacy"');
    expect(footer).toContain('Todos los derechos reservados');
    setRequestLocale('en-AU');
    expect(html(await SiteHeader())).toContain('href="/races"');
  });
});

describe('pages in another language', () => {
  it('renders the interface in that language and links within it', async () => {
    stubCatalogue({});
    const out = html(await Home(params('es-ES')));
    expect(out).toContain('Corre el mundo');
    expect(out).toContain('href="/es-ES/races"');
    expect(html(await Home(params('en-AU')))).toContain('Run the world');
  });

  it('shows the questions published in that language and not those of another', async () => {
    const q = (id: string, question: string, locale: string) => ({ id, category: '', question, answer: 'A', sortOrder: 0, locale });
    stubCatalogue({ content: { faqs: [q('1', 'Is it safe?', 'en-AU'), q('2', '¿Es seguro?', 'es-ES')] } });
    const spanish = html(await FaqPage(params('es-ES')));
    expect(spanish).toContain('¿Es seguro?');
    expect(spanish).not.toContain('Is it safe?');
    expect(spanish).toContain('Preguntas frecuentes');
    expect(html(await FaqPage(params('en-AU')))).toContain('Is it safe?');
  });

  it('does not fall back to another language for content: no Spanish page means the built-in Spanish wording', async () => {
    stubCatalogue({ content: { pages: { about: contentPage({ slug: 'about', title: 'Who we are' }) } } });
    const out = html(await AboutPage(params('es-ES')));
    expect(out).not.toContain('Who we are');
    expect(out).toContain('Sobre Marathon Trips');
  });

  it('keeps the pending-legal-review notice in every language', async () => {
    stubCatalogue({ content: { pages: { about: contentPage({ slug: 'about', locale: 'es-ES', legalReviewPending: true }) } } });
    expect(html(await AboutPage(params('es-ES')))).toContain('pendiente de revisión legal');
  });

  it('answers a content page 404 in a language it has not been written in', async () => {
    stubCatalogue({ content: { pages: { [SLUG]: contentPage({ locale: 'en-AU' }) } } });
    await expect(ContentPage(params('es-ES', { slug: SLUG }))).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(html(await ContentPage(params('en-AU', { slug: SLUG })))).toContain('A page from the content manager');
  });

  it('shows a race name in the visitor’s language when the catalogue has one, else English, else any language', () => {
    const name = { 'en-AU': 'Sample Marathon', 'es-ES': 'Maratón de Muestra' };
    setRequestLocale('es-ES');
    expect(localisedText(name)).toBe('Maratón de Muestra');
    expect(localisedText({ 'en-AU': 'Sample Marathon' })).toBe('Sample Marathon');
    expect(localisedText({ 'fr-FR': 'Marathon' })).toBe('Marathon');
    setRequestLocale('en-AU');
    expect(localisedText(name)).toBe('Sample Marathon');
  });
});

describe('hreflang', () => {
  it('lists every enabled language, each at its own address, plus x-default for the default', async () => {
    stubCatalogue({});
    const m = await homeMetadata(params('es-ES'));
    expect(languagesOf(m)).toEqual({ 'en-AU': 'http://localhost:3000/', 'es-ES': 'http://localhost:3000/es-ES', 'x-default': 'http://localhost:3000/' });
    expect(m.alternates?.canonical).toBe('http://localhost:3000/es-ES');
    expect(m.openGraph).toMatchObject({ locale: 'es_ES' });
  });

  it('has the page itself and x-default only, with one language enabled, and never lists a language that is not enabled', async () => {
    delete process.env.ENABLED_LOCALES;
    stubCatalogue({});
    const m = await aboutMetadata(params('en-AU'));
    expect(Object.keys(languagesOf(m))).toEqual(['en-AU', 'x-default']);
    expect(m.alternates?.canonical).toBe('http://localhost:3000/about');
  });

  it('lists a content page only in the languages it is published in', async () => {
    stubCatalogue({ content: { pages: { [SLUG]: contentPage({ locale: 'en-AU' }) } } });
    expect(Object.keys(languagesOf(await contentMetadata(params('en-AU', { slug: SLUG }))))).toEqual(['en-AU', 'x-default']);
    stubCatalogue({ content: { pages: { [SLUG]: contentPage({ locale: 'es-ES' }) } } });
    // Written only in Spanish: x-default points at the one that exists.
    const only = languagesOf(await contentMetadata(params('es-ES', { slug: SLUG })));
    expect(only).toEqual({ 'es-ES': `http://localhost:3000/es-ES/pages/${SLUG}`, 'x-default': `http://localhost:3000/es-ES/pages/${SLUG}` });
  });

  it('lists the questions page only in languages that have questions', async () => {
    const q = { id: '1', category: '', question: 'Q', answer: 'A', sortOrder: 0 };
    stubCatalogue({ content: { faqs: [q] } });
    expect(Object.keys(languagesOf(await faqMetadata(params('en-AU'))))).toEqual(['en-AU', 'x-default']);
  });

  it('points race pages at each language and puts the language in structured data addresses', async () => {
    stubCatalogue({});
    const m = await raceMetadata({ params: Promise.resolve({ locale: 'es-ES', slug: SLUG }) });
    expect(languagesOf(m)['es-ES']).toBe(`http://localhost:3000/es-ES/races/${SLUG}`);
    const out = html(await RacePage({ params: Promise.resolve({ locale: 'es-ES', slug: SLUG }) }));
    expect(out).toContain(`http://localhost:3000/es-ES/races/${SLUG}`);
  });
});

describe('sitemap', () => {
  it('lists each language of each page with the full hreflang set', async () => {
    stubCatalogue({ content: { pages: { cookies: contentPage({ slug: 'cookies', locale: 'en-AU' }) } } });
    const entries = await sitemap();
    const races = entries.filter((e) => e.url.endsWith(`/races/${summary().slug}`));
    expect(races.map((e) => e.url).sort()).toEqual([`http://localhost:3000/es-ES/races/${summary().slug}`, `http://localhost:3000/races/${summary().slug}`]);
    expect(races[0]!.alternates?.languages).toMatchObject({ 'en-AU': `http://localhost:3000/races/${summary().slug}`, 'es-ES': `http://localhost:3000/es-ES/races/${summary().slug}`, 'x-default': `http://localhost:3000/races/${summary().slug}` });
    // A page published in English only is listed once, in English.
    expect(entries.filter((e) => e.url.includes('/pages/cookies')).map((e) => e.url)).toEqual(['http://localhost:3000/pages/cookies']);
    // Built-in pages exist in both languages; the questions page has no Spanish questions, so only English.
    expect(entries.filter((e) => e.url.endsWith('/about')).length).toBe(2);
    expect(entries.some((e) => e.url === 'http://localhost:3000/es-ES/about')).toBe(true);
    expect(entries.some((e) => e.url.endsWith('/es-ES/faq'))).toBe(false);
  });

  it('is the same as before with one language: one plain address per page', async () => {
    delete process.env.ENABLED_LOCALES;
    stubCatalogue({});
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.some((u) => u.includes('/es-ES'))).toBe(false);
    expect(urls).toContain('http://localhost:3000/races');
  });
});

describe('the proxy and languages', () => {
  const request = (path: string, cookie?: string, headers: Record<string, string> = {}) => ({
    headers: new Headers(headers),
    method: 'GET', nextUrl: new URL(`http://localhost:3000${path}`), url: `http://localhost:3000${path}`,
    cookies: { get: (n: string) => (n === 'mt_locale' && cookie ? { value: cookie } : undefined) },
  });

  it('serves the default language from underneath and an enabled one at its prefix', async () => {
    stubCatalogue({});
    const plain = await proxy(request('/races?q=a') as never);
    expect(plain.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/en-AU/races?q=a');
    const spanish = await proxy(request('/es-ES/races') as never);
    expect(spanish.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/es-ES/races');
    expect(spanish.cookies.get('mt_locale')?.value).toBe('es-ES');
    expect(spanish.headers.get('vary')).toContain('Cookie');
  });

  it('keeps a returning visitor’s language, and lets them switch back with the written-out default', async () => {
    stubCatalogue({});
    const back = await proxy(request('/races', 'es-ES') as never);
    expect(back.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/es-ES/races');
    const switched = await proxy(request('/en-AU/races?page=2', 'es-ES') as never);
    expect(switched.status).toBe(308);
    expect(switched.headers.get('location')).toBe('http://localhost:3000/races?page=2');
    expect(switched.cookies.get('mt_locale')?.value).toBe('en-AU');
  });

  it('does not let the framework’s background fetches change the remembered language', async () => {
    stubCatalogue({});
    for (const h of [{ rsc: '1' }, { 'next-router-prefetch': '1' }, { 'sec-fetch-dest': 'empty' }] as Array<Record<string, string>>) {
      const res = await proxy(request('/es-ES/races', 'en-AU', h) as never);
      expect(res.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/es-ES/races');
      expect(res.cookies.get('mt_locale')).toBeUndefined();
    }
    const nav = await proxy(request('/es-ES/races', undefined, { 'sec-fetch-dest': 'document' }) as never);
    expect(nav.cookies.get('mt_locale')?.value).toBe('es-ES');
  });

  it('ignores a remembered language that is no longer enabled', async () => {
    delete process.env.ENABLED_LOCALES;
    stubCatalogue({});
    const res = await proxy(request('/races', 'es-ES') as never);
    expect(res.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/en-AU/races');
    expect(res.headers.get('vary')).toBeNull();
  });

  it('applies a redirect from the content manager inside a language and keeps the language in the target', async () => {
    stubCatalogue({ content: { redirects: [{ fromPath: '/old-guide', toPath: '/races', statusCode: 301 }] } });
    const hit = await proxy(request('/es-ES/old-guide') as never);
    expect(hit.status).toBe(301);
    expect(hit.headers.get('location')).toBe('http://localhost:3000/es-ES/races');
  });
});
