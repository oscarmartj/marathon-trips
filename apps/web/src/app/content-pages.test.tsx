import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Banners } from '@/components/banners';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { proxy } from '@/proxy';
import { resetRedirectCache } from '@/lib/redirects';
import { SLUG, contentGuide, contentPage, stubCatalogue } from '@/test/catalogue-fixtures';
import AboutPage from './(public)/about/page';
import ContentPage, { generateMetadata as contentMetadata } from './(public)/pages/[slug]/page';
import FaqPage from './(public)/faq/page';
import RacePage, { generateMetadata as raceMetadata } from './(public)/races/[slug]/page';
import TermsPage from './(public)/legal/terms/page';
import sitemap from './sitemap';

afterEach(() => {
  vi.unstubAllGlobals();
  resetRedirectCache();
});

const html = (el: unknown) => renderToStaticMarkup(el as never);
const props = { params: Promise.resolve({ slug: SLUG }) };

describe('pages written in the content manager', () => {
  it('shows a published page as paragraphs of text, with its own heading and introduction', async () => {
    stubCatalogue({ content: { pages: { about: contentPage({ slug: 'about', title: 'Who we are', intro: 'Runners helping runners.', body: 'We started small.\n\nNow we are bigger.' }) } } });
    const out = html(await AboutPage());
    expect(out).toContain('<h1>Who we are</h1>');
    expect(out).toContain('Runners helping runners.');
    expect(out.match(/<p class="prose">/g)).toHaveLength(2);
    expect(out).not.toContain('placeholder');
  });

  it('shows markup in the text as text, never as markup', async () => {
    stubCatalogue({ content: { pages: { about: contentPage({ slug: 'about', body: '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>' }) } } });
    const out = html(await AboutPage());
    expect(out).not.toMatch(/<script>alert|<img src=x/);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('falls back to the built-in placeholder when no page is published or the content API is down', async () => {
    stubCatalogue({ content: { pages: {} } });
    expect(html(await AboutPage())).toContain('placeholder');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const out = html(await AboutPage());
    expect(out.match(/<h1[ >]/g)).toHaveLength(1);
    expect(out).toContain('placeholder');
  });

  it('shows a header image from the library with its description, and an empty description when decorative', async () => {
    const media = { src: 'https://img.example.com/h.jpg', altText: 'Runners at dawn', decorative: false, width: 1200, height: 800 };
    stubCatalogue({ content: { pages: { about: contentPage({ slug: 'about', heroMedia: media }) } } });
    expect(html(await AboutPage())).toMatch(/<img[^>]*alt="Runners at dawn"[^>]*width="1200"[^>]*height="800"/);
    stubCatalogue({ content: { pages: { about: contentPage({ slug: 'about', heroMedia: { ...media, altText: '', decorative: true } }) } } });
    expect(html(await AboutPage())).toMatch(/<img[^>]*alt=""/);
  });

  it('serves a page with no route of its own at /pages/<slug>, 404s an unknown one, and sends the dedicated slugs to their own address', async () => {
    stubCatalogue({});
    expect(html(await ContentPage(props))).toContain('A page from the content manager');
    await expect(ContentPage({ params: Promise.resolve({ slug: 'missing' }) })).rejects.toThrow(/404/);
    await expect(ContentPage({ params: Promise.resolve({ slug: 'terms' }) })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(((await contentMetadata(props)).title as string)).toBe('A page from the content manager');
    expect((await contentMetadata({ params: Promise.resolve({ slug: 'missing' }) })).robots).toMatchObject({ index: false });
  });
});

describe('legal pages stay marked as pending until reviewed', () => {
  it('shows the notice for a published legal page that is pending, and not once it has been reviewed', async () => {
    stubCatalogue({ content: { pages: { terms: contentPage({ slug: 'terms', kind: 'legal', legalReviewPending: true }) } } });
    expect(html(await TermsPage())).toContain('pending legal review');
    stubCatalogue({ content: { pages: { terms: contentPage({ slug: 'terms', kind: 'legal', legalReviewPending: false }) } } });
    expect(html(await TermsPage())).not.toContain('pending legal review');
  });

  it('shows the notice on the built-in placeholder when nothing is published or the API is down', async () => {
    stubCatalogue({ content: { pages: {} } });
    expect(html(await TermsPage())).toContain('pending legal review');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(html(await TermsPage())).toContain('pending legal review');
  });
});

describe('FAQ', () => {
  const faq = (id: string, category: string, question: string) => ({ id, category, question, answer: `Answer to ${question}\n\nMore.`, sortOrder: 0 });

  it('lists the questions under their headings and describes them to search engines', async () => {
    stubCatalogue({ content: { faqs: [faq('1', '', 'Can I bring family?'), faq('2', 'Payments', 'Is there a deposit?')] } });
    const out = html(await FaqPage());
    expect(out).toContain('General questions');
    expect(out).toContain('Payments');
    expect(out).toContain('Is there a deposit?');
    expect(out.match(/<h1[ >]/g)).toHaveLength(1);
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(out)![1]!.replace(/\\u003c/g, '<')) as { '@type': string; mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity.map((q) => q.name)).toEqual(['Can I bring family?', 'Is there a deposit?']);
    expect(ld.mainEntity[0]!.acceptedAnswer.text).toContain('Answer to Can I bring family?');
  });

  it('says so, with no structured data, when there are no questions', async () => {
    stubCatalogue({});
    const out = html(await FaqPage());
    expect(out).toContain('will appear here soon');
    expect(out).not.toContain('application/ld+json');
  });
});

describe('banners and menus', () => {
  it('shows each banner with its kind in words, its message and its link, and nothing when there are none', async () => {
    stubCatalogue({
      content: { banners: [
        { id: 'b1', message: 'Entries now open.', linkLabel: 'See races', linkHref: '/races', tone: 'notice' },
        { id: 'b2', message: 'Office closed.', linkLabel: 'Details', linkHref: 'https://example.com/closed', tone: 'warning' },
        { id: 'b3', message: 'A plain update.', linkLabel: '', linkHref: '', tone: 'info' },
      ] },
    });
    const out = html(await Banners());
    expect(out).toContain('aria-label="Announcements"');
    expect(out).toMatch(/banner--notice[^>]*><span class="banner__tone">Notice<\/span><span>Entries now open\.<\/span><a href="\/races">See races<\/a>/);
    expect(out).toContain('banner--warning');
    expect(out).toContain('Warning');
    expect(out).toMatch(/<a href="https:\/\/example\.com\/closed" rel="noopener noreferrer">Details<\/a>/);
    expect(out).not.toMatch(/<a [^>]*>\s*<\/a>/);
    stubCatalogue({});
    expect(html(await Banners())).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(html(await Banners())).toBe('');
  });

  it('uses the published menu when there is one, and the built-in links when there is not', async () => {
    stubCatalogue({ content: { menu: { header: [{ label: 'Our races', href: '/races' }, { label: 'Blog', href: 'https://blog.example.com' }], footer_legal: [{ label: 'Cookies', href: '/pages/cookies' }] } } });
    const header = html(await SiteHeader());
    expect(header).toContain('Our races');
    expect(header).toContain('rel="noopener noreferrer"');
    expect(header).not.toContain('>FAQ<');
    const footer = html(await SiteFooter());
    expect(footer).toContain('Cookies');
    expect(footer).toContain('Contact');
    expect(footer).not.toContain('Privacy policy');
    stubCatalogue({});
    expect(html(await SiteHeader())).toMatch(/>Races<[\s\S]*>FAQ</);
    expect(html(await SiteFooter())).toContain('Privacy policy');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(html(await SiteHeader())).toContain('Races');
    expect(html(await SiteFooter())).toContain('Terms of booking');
  });
});

describe('race guide', () => {
  it('shows the guide sections staff wrote, and the general wording for the ones they did not', async () => {
    stubCatalogue({ content: { guides: { [SLUG]: contentGuide({ climate: '', entry: '' }) } } });
    const out = html(await RacePage(props));
    expect(out).toContain('The course');
    expect(out).toContain('Out and back along the lake.');
    expect(out).not.toContain('Climate and conditions');
    expect(out).toContain('Fly into Auckland.');
    expect(out).toContain('Entry options differ by package');
  });

  it('shows the generic race page when there is no guide, and uses the guide\'s search title and image when there is', async () => {
    stubCatalogue({});
    const plain = html(await RacePage(props));
    expect(plain).not.toContain('The course');
    expect(plain).toContain('Entry options differ by package');
    const media = { src: '/placeholders/hero.svg', altText: 'Lake course', decorative: false, width: null, height: null };
    stubCatalogue({ content: { guides: { [SLUG]: contentGuide({ seoTitle: 'Run Rotorua', seoDescription: 'A lakeside marathon.', heroMedia: media }) } } });
    expect(html(await RacePage(props))).toMatch(/<img[^>]*alt="Lake course"/);
    expect(await raceMetadata(props)).toMatchObject({ title: 'Run Rotorua', description: 'A lakeside marathon.' });
  });

  it('makes no accreditation or guaranteed-entry claim of its own', async () => {
    stubCatalogue({ content: { guides: { [SLUG]: contentGuide() } } });
    expect(html(await RacePage(props))).not.toMatch(/official (partner|operator)|guaranteed entry|accredited/i);
  });
});

describe('sitemap', () => {
  it('lists published general pages once, and leaves out the pages that have a route of their own', async () => {
    stubCatalogue({ content: { pages: { cookies: contentPage({ slug: 'cookies' }), about: contentPage({ slug: 'about' }), terms: contentPage({ slug: 'terms', kind: 'legal' }) } } });
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain('http://localhost:3000/pages/cookies');
    expect(urls.filter((u) => u.endsWith('/about'))).toHaveLength(1);
    expect(urls.some((u) => u.includes('/pages/about') || u.includes('/pages/terms'))).toBe(false);
  });
});

describe('redirect proxy', () => {
  const request = (path: string, method = 'GET') => ({ method, nextUrl: new URL(`http://localhost:3000${path}`), url: `http://localhost:3000${path}` });

  it('sends a visitor to the new address with the status staff chose, and leaves other requests alone', async () => {
    stubCatalogue({ content: { redirects: [{ fromPath: '/old-guide', toPath: '/races', statusCode: 301 }] } });
    const hit = await proxy(request('/old-guide?utm=a') as never);
    expect(hit.status).toBe(301);
    expect(hit.headers.get('location')).toBe('http://localhost:3000/races?utm=a');
    const miss = await proxy(request('/faq') as never);
    expect(miss.headers.get('location')).toBeNull();
    const post = await proxy(request('/old-guide', 'POST') as never);
    expect(post.headers.get('location')).toBeNull();
  });
});
