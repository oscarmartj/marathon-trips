import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_KINDS } from '@mt/shared';
import { ADMIN_KINDS, CREATE_ONLY, contentBody, contentInitial, fromLocalInput, publicPath, toLocalInput, wholeOr } from './content-admin';
import { DEDICATED_PAGE_PATHS, contentGet, getMenu, groupFaqs, isExternalHref, listBanners, paragraphs } from './content';
import { findRedirect, loadRedirects, resetRedirectCache } from './redirects';

afterEach(() => {
  vi.unstubAllGlobals();
  resetRedirectCache();
});

describe('plain text', () => {
  it('splits at blank lines, trims, and drops empty paragraphs', () => {
    expect(paragraphs('One.\n\n  Two.  \r\n\r\n\n\nThree\nstill three.\n\n ')).toEqual(['One.', 'Two.', 'Three\nstill three.']);
    expect(paragraphs('   ')).toEqual([]);
  });

  it('keeps markup as characters', () => {
    expect(paragraphs('<script>alert(1)</script>\n\n<b>x</b>')).toEqual(['<script>alert(1)</script>', '<b>x</b>']);
  });

  it('groups questions by heading in the order sent, uncategorised first when the API sends them first', () => {
    const q = (id: string, category: string) => ({ id, category, question: id, answer: 'a', sortOrder: 0 });
    expect(groupFaqs([q('a', ''), q('b', 'Payments'), q('c', ''), q('d', 'Payments')]).map((g) => [g.category, g.items.map((i) => i.id)])).toEqual([['', ['a', 'c']], ['Payments', ['b', 'd']]]);
    expect(groupFaqs([])).toEqual([]);
  });

  it('treats only https addresses as outside links', () => {
    expect(isExternalHref('https://example.com')).toBe(true);
    for (const h of ['/faq', 'http://example.com', 'javascript:alert(1)']) expect(isExternalHref(h)).toBe(false);
  });
});

describe('content reads never break a page', () => {
  it('give null or an empty list when the API is down, answers an error, or sends nonsense', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    expect(await contentGet('/content/pages/x')).toBeNull();
    expect(await listBanners()).toEqual([]);
    expect(await getMenu()).toEqual({ header: [], footer_company: [], footer_legal: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await contentGet('/content/pages/x')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await contentGet('/content/pages/x')).toBeNull();
  });

  it('asks the API for each page by its encoded slug and caches for a minute', async () => {
    const fetchMock = vi.fn(async () => new Response('{"title":"x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await contentGet('/content/pages/a%20b');
    const init = (fetchMock.mock.calls as unknown as Array<[string, { next?: { revalidate?: number } }]>)[0]![1];
    expect(init.next?.revalidate).toBe(60);
  });
});

describe('redirect rules', () => {
  const rules = [
    { fromPath: '/old', toPath: '/new', statusCode: 301 },
    { fromPath: '/temp', toPath: '/races?country=AU', statusCode: 302 },
    { fromPath: '/away', toPath: 'https://example.com/x', statusCode: 308 },
    { fromPath: '/self', toPath: '/self?x=1', statusCode: 301 },
    { fromPath: '/bad-code', toPath: '/new', statusCode: 303 },
    { fromPath: '/bad-target', toPath: 'javascript:alert(1)', statusCode: 301 },
    { fromPath: '/proto', toPath: '//evil.example', statusCode: 301 },
    { fromPath: '/admin/staff', toPath: '/faq', statusCode: 301 },
  ];

  it('redirects with the rule\'s status, ignoring a trailing slash, and carries the query string unless the target has its own', () => {
    expect(findRedirect(rules, '/old')).toEqual({ location: '/new', status: 301 });
    expect(findRedirect(rules, '/old/', '?utm=1')).toEqual({ location: '/new?utm=1', status: 301 });
    expect(findRedirect(rules, '/temp', '?utm=1')).toEqual({ location: '/races?country=AU', status: 302 });
    expect(findRedirect(rules, '/away')).toEqual({ location: 'https://example.com/x', status: 308 });
  });

  it('does nothing for an unknown path, a rule that points at itself, a status that is not a redirect, or an unsafe target', () => {
    for (const p of ['/nothing', '/self', '/bad-code', '/bad-target', '/proto']) expect(findRedirect(rules, p), p).toBeNull();
  });

  it('never touches the panel, the API proxy, build output or files', () => {
    for (const p of ['/admin/staff', '/admin', '/api/health', '/_next/static/x.js', '/robots.txt', '/old.png']) expect(findRedirect([...rules, { fromPath: p, toPath: '/faq', statusCode: 301 }], p), p).toBeNull();
  });

  it('keeps the list for 30 seconds, and the last good list when the API fails', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ items: rules.slice(0, 1) }), { status: 200 }));
    expect(await loadRedirects(1000, ok as unknown as typeof fetch)).toHaveLength(1);
    expect(await loadRedirects(20_000, ok as unknown as typeof fetch)).toHaveLength(1);
    expect(ok).toHaveBeenCalledTimes(1);
    const down = vi.fn(async () => { throw new Error('down'); });
    expect(await loadRedirects(40_000, down as unknown as typeof fetch)).toHaveLength(1);
    expect(await loadRedirects(45_000, down as unknown as typeof fetch)).toHaveLength(1);
    expect(down).toHaveBeenCalledTimes(1);
    expect(await loadRedirects(51_000, ok as unknown as typeof fetch)).toHaveLength(1);
    expect(ok).toHaveBeenCalledTimes(2);
  });

  it('applies no redirects when the API has never answered', async () => {
    const down = vi.fn(async () => new Response('{}', { status: 503 }));
    expect(await loadRedirects(1, down as unknown as typeof fetch)).toEqual([]);
  });
});

describe('the content manager forms', () => {
  it('builds a page body, and leaves out the language and type when updating', () => {
    const v = contentInitial('pages');
    Object.assign(v, { slug: ' about-us ', title: ' About ', body: 'Text', heroMediaId: '' });
    expect(contentBody('pages', v, 'create')).toMatchObject({ locale: 'en-AU', slug: 'about-us', kind: 'general', title: 'About', heroMediaId: null });
    const update = contentBody('pages', v, 'update');
    expect(update).not.toHaveProperty('locale');
    expect(update).not.toHaveProperty('kind');
    expect(update).toHaveProperty('slug', 'about-us');
  });

  it('leaves out of an update exactly the fields that are fixed once saved', () => {
    for (const kind of ADMIN_KINDS) {
      const update = contentBody(kind, contentInitial(kind), 'update');
      for (const key of CREATE_ONLY[kind]) expect(update, `${kind}.${key}`).not.toHaveProperty(key);
    }
  });

  it('turns numbers and dates into what the API expects, and passes bad input on so the API can say so', () => {
    expect(contentBody('faqs', { ...contentInitial('faqs'), question: 'Q', answer: 'A', sortOrder: '12' }, 'create')).toMatchObject({ sortOrder: 12 });
    expect(wholeOr('', 0)).toBe(0);
    expect(wholeOr('7', null)).toBe(7);
    expect(wholeOr('x', null)).toBe('x');
    expect(contentBody('media', { ...contentInitial('media'), label: 'L', src: '/a.svg', width: '', height: '' }, 'create')).toMatchObject({ width: null, height: null });
    expect(contentBody('redirects', { ...contentInitial('redirects'), fromPath: '/a', toPath: '/b' }, 'create')).toMatchObject({ statusCode: 301, enabled: true });
  });

  it('clears the description of a decorative image, and a date survives the round trip through a form', () => {
    expect(contentBody('media', { ...contentInitial('media'), label: 'L', src: '/a.svg', altText: 'left over', decorative: true }, 'create')).toMatchObject({ altText: '', decorative: true });
    const iso = '2027-03-04T05:06:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
    expect(toLocalInput(null)).toBe('');
    expect(toLocalInput('garbage')).toBe('');
  });

  it('knows where a published item appears on the public site', () => {
    const row = (o: Record<string, unknown>) => ({ id: 'x', version: 0, ...o });
    expect(publicPath('pages', row({ slug: 'terms' }))).toBe('/legal/terms');
    expect(publicPath('pages', row({ slug: 'cookies' }))).toBe('/pages/cookies');
    expect(publicPath('guides', row({ race: { slug: 'sample' } }))).toBe('/races/sample');
    expect(publicPath('faqs', row({}))).toBe('/faq');
    expect(publicPath('banners', row({}))).toBeNull();
  });

  it('covers every kind the API serves, plus redirects, and agrees with the web on which pages have their own route', () => {
    expect([...ADMIN_KINDS].sort()).toEqual([...CONTENT_KINDS, 'redirects'].sort());
    for (const [slug, path] of Object.entries(DEDICATED_PAGE_PATHS)) expect(publicPath('pages', { id: 'x', version: 0, slug }), slug).toBe(path);
  });
});
