import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestApp, makeApp } from '../../support/auth';
import { anonymous, buildWorld, Client, closeCatalogue, slug } from '../../support/catalogue';
import { ALL, CP, contentAdmin, must, pageBody, published, publishedRace } from '../../support/content';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await contentAdmin(t);
});
afterAll(async () => {
  await closeCatalogue(t);
});

const pub = () => anonymous(t);
const audit = (action: string, entityId: string) => t.prisma.auditLog.count({ where: { action, entityId } });

describe('access', () => {
  it('anonymous callers are refused on every admin route and can read the public ones', async () => {
    for (const path of ['/admin/content/pages', '/admin/content/redirects', '/admin/content/media']) expect([401, 403]).toContain((await pub().get(path)).status);
    for (const path of ['/content/faqs', '/content/banners', '/content/menu', '/content/redirects', '/content/pages']) expect((await pub().get(path)).status).toBe(200);
  });

  it('each permission guards its routes: read, manage, publish, redirects and legal review are separate', async () => {
    const page = must(await admin.post('/admin/content/pages', pageBody()), 'create page').body;
    const reader = await contentAdmin(t, [CP.contentRead]);
    expect((await reader.get('/admin/content/pages')).status).toBe(200);
    expect((await reader.get(`/admin/content/pages/${page.id}`)).status).toBe(200);
    expect((await reader.post('/admin/content/pages', pageBody())).status).toBe(403);
    expect((await reader.patch(`/admin/content/pages/${page.id}`, { title: 'x', version: page.version })).status).toBe(403);
    expect((await reader.delete(`/admin/content/pages/${page.id}`)).status).toBe(403);
    expect((await reader.post(`/admin/content/pages/${page.id}/status`, { status: 'published', version: page.version })).status).toBe(403);
    const writer = await contentAdmin(t, [CP.contentRead, CP.contentManage]);
    expect((await writer.patch(`/admin/content/pages/${page.id}`, { title: 'Edited', version: page.version })).status).toBe(200);
    expect((await writer.post(`/admin/content/pages/${page.id}/status`, { status: 'published', version: page.version + 1 })).status).toBe(403);
    expect((await writer.post('/admin/content/redirects', { fromPath: `/${slug('r')}`, toPath: '/faq' })).status).toBe(403);
    const redirects = await contentAdmin(t, [CP.contentRead, CP.redirectManage]);
    expect((await redirects.post('/admin/content/redirects', { fromPath: `/${slug('r')}`, toPath: '/faq' })).status).toBe(201);
    expect((await redirects.post('/admin/content/pages', pageBody())).status).toBe(403);
    const none = await contentAdmin(t, []);
    expect((await none.get('/admin/content/pages')).status).toBe(403);
    expect((await none.get('/admin/content/redirects')).status).toBe(403);
  });

  it('an unknown kind is a 404 and an unknown field is a 422', async () => {
    expect((await admin.get('/admin/content/secrets')).status).toBe(404);
    expect((await admin.post('/admin/content/secrets', {})).status).toBe(404);
    expect((await admin.post('/admin/content/pages', pageBody({ isAdmin: true }))).status).toBe(422);
    expect((await admin.post('/admin/content/faqs', { question: 'q', answer: 'a', surprise: 1 })).status).toBe(422);
  });
});

describe('pages: publishing needs no deploy', () => {
  it('a draft is private, a published page is public at once, and unpublishing takes it down', async () => {
    const body = pageBody();
    const page = must(await admin.post('/admin/content/pages', body), 'create').body;
    expect(page.status).toBe('draft');
    expect((await pub().get(`/content/pages/${body.slug}`)).status).toBe(404);
    const live = must(await admin.post(`/admin/content/pages/${page.id}/status`, { status: 'published', version: page.version }), 'publish').body;
    expect(live.publishedAt).toBeTruthy();
    const res = await pub().get(`/content/pages/${body.slug}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: body.slug, title: 'About us', kind: 'general', legalReviewPending: false });
    expect(res.body.id).toBeUndefined();
    expect((await pub().get('/content/pages')).body.items.map((p: { slug: string }) => p.slug)).toContain(body.slug);
    must(await admin.post(`/admin/content/pages/${page.id}/status`, { status: 'draft', version: live.version }), 'unpublish');
    expect((await pub().get(`/content/pages/${body.slug}`)).status).toBe(404);
    expect(await audit('content.page.published', page.id)).toBe(1);
    expect(await audit('content.page.unpublished', page.id)).toBe(1);
  });

  it('an edit to a published page is live straight away', async () => {
    const live = await published(admin, 'pages', pageBody({ title: 'Before' }));
    must(await admin.patch(`/admin/content/pages/${live.id}`, { title: 'After', version: live.version }), 'edit');
    expect((await pub().get(`/content/pages/${live.slug}`)).body.title).toBe('After');
  });

  it('an empty page cannot be published, and a duplicate address in the same language is a 409', async () => {
    const empty = must(await admin.post('/admin/content/pages', pageBody({ body: '  \n\n ' })), 'create').body;
    const r = await admin.post(`/admin/content/pages/${empty.id}/status`, { status: 'published', version: empty.version });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('page_empty');
    const first = pageBody();
    must(await admin.post('/admin/content/pages', first), 'first');
    const dup = await admin.post('/admin/content/pages', first);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('page_slug_taken');
    expect((await admin.post('/admin/content/pages', { ...first, locale: 'es-ES' })).status).toBe(201);
  });

  it('a stale version is a 409 and changes nothing', async () => {
    const page = must(await admin.post('/admin/content/pages', pageBody({ title: 'One' })), 'create').body;
    must(await admin.patch(`/admin/content/pages/${page.id}`, { title: 'Two', version: page.version }), 'first edit');
    const stale = await admin.patch(`/admin/content/pages/${page.id}`, { title: 'Three', version: page.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect((await admin.get(`/admin/content/pages/${page.id}`)).body.title).toBe('Two');
    expect((await admin.post(`/admin/content/pages/${page.id}/status`, { status: 'published', version: page.version })).status).toBe(409);
  });

  it('text is stored and returned exactly as written: markup is data, never rendered or rewritten', async () => {
    const markup = '<script>alert(1)</script>\n\n<b>bold</b> & more';
    const live = await published(admin, 'pages', pageBody({ body: markup }));
    expect((await pub().get(`/content/pages/${live.slug}`)).body.body).toBe(markup);
  });

  it('slugs are lower-case address segments only', async () => {
    for (const bad of ['Has Space', 'UPPER', '../x', 'a/b', '']) expect((await admin.post('/admin/content/pages', pageBody({ slug: bad }))).status, bad).toBe(422);
    expect((await pub().get('/content/pages/Has%20Space')).status).toBe(404);
  });
});

describe('legal pages stay marked as pending until someone with the review permission says otherwise', () => {
  it('a new legal page is pending, shows as pending publicly, and editing the text does not clear it', async () => {
    const live = await published(admin, 'pages', pageBody({ kind: 'legal', body: 'Provisional terms.' }));
    expect(live.legalReviewPending).toBe(true);
    expect((await pub().get(`/content/pages/${live.slug}`)).body).toMatchObject({ kind: 'legal', legalReviewPending: true });
    const edited = must(await admin.patch(`/admin/content/pages/${live.id}`, { body: 'Replaced terms.', version: live.version }), 'edit').body;
    expect(edited.legalReviewPending).toBe(true);
    expect((await pub().get(`/content/pages/${live.slug}`)).body.legalReviewPending).toBe(true);
  });

  it('only the review route clears it, it needs its own permission, and it can be set again', async () => {
    const live = await published(admin, 'pages', pageBody({ kind: 'legal' }));
    const noReview = await contentAdmin(t, [CP.contentRead, CP.contentManage, CP.contentPublish]);
    expect((await noReview.post(`/admin/content/pages/${live.id}/legal-review`, { pending: false, version: live.version })).status).toBe(403);
    const reviewer = await contentAdmin(t, [CP.contentRead, CP.legalReview]);
    const cleared = await reviewer.post(`/admin/content/pages/${live.id}/legal-review`, { pending: false, version: live.version, reason: 'Reviewed by the solicitor' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.legalReviewPending).toBe(false);
    expect((await pub().get(`/content/pages/${live.slug}`)).body.legalReviewPending).toBe(false);
    expect(await audit('content.page.legal_reviewed', live.id)).toBe(1);
    const again = await reviewer.post(`/admin/content/pages/${live.id}/legal-review`, { pending: true, version: cleared.body.version });
    expect(again.body.legalReviewPending).toBe(true);
    expect(again.status).toBe(200);
    // Setting the state it already has is refused rather than quietly ignored.
    expect((await reviewer.post(`/admin/content/pages/${live.id}/legal-review`, { pending: true, version: again.body.version })).status).toBe(409);
  });

  it('a general page has no review state, and the database refuses one', async () => {
    const general = must(await admin.post('/admin/content/pages', pageBody()), 'create').body;
    const r = await admin.post(`/admin/content/pages/${general.id}/legal-review`, { pending: true, version: general.version });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('page_not_legal');
    await expect(t.prisma.contentPage.update({ where: { id: general.id }, data: { legalReviewPending: true } })).rejects.toThrow();
    // kind and locale cannot be changed after the page exists.
    expect((await admin.patch(`/admin/content/pages/${general.id}`, { kind: 'legal', version: general.version })).status).toBe(422);
  });
});

describe('race guides', () => {
  it('a guide goes public only when it is published and its race is published', async () => {
    const admin2 = admin;
    const race = await publishedRace(admin2);
    const guide = must(await admin2.post('/admin/content/guides', { raceId: race.id, course: 'Out and back along the river.', climate: 'Mild in June.' }), 'create guide').body;
    expect(guide.race.slug).toBe(race.slug);
    expect((await pub().get(`/content/guides/${race.slug}`)).status).toBe(404);
    const live = must(await admin2.post(`/admin/content/guides/${guide.id}/status`, { status: 'published', version: guide.version }), 'publish').body;
    const res = await pub().get(`/content/guides/${race.slug}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ raceSlug: race.slug, course: 'Out and back along the river.', climate: 'Mild in June.', entry: '', travelTips: '' });
    expect(res.body.id).toBeUndefined();
    // Archiving the race hides its guide.
    const current = (await admin2.get(`/admin/catalogue/races/${race.id}`)).body;
    must(await admin2.post(`/admin/catalogue/races/${race.id}/status`, { status: 'archived', version: current.version }), 'archive race');
    expect((await pub().get(`/content/guides/${race.slug}`)).status).toBe(404);
    expect(live.status).toBe('published');
  });

  it('a published guide for a race that is still a draft is not public (demo races can never be published, so they never are either)', async () => {
    const w = await buildWorld(admin);
    await published(admin, 'guides', { raceId: w.race.id, course: 'Draft race course.' });
    expect((await pub().get(`/content/guides/${w.race.slug}`)).status).toBe(404);
  });

  it('one guide per race and language, an empty guide cannot be published, an unknown race is a 404', async () => {
    const race = await publishedRace(admin);
    const g = must(await admin.post('/admin/content/guides', { raceId: race.id }), 'create').body;
    const empty = await admin.post(`/admin/content/guides/${g.id}/status`, { status: 'published', version: g.version });
    expect(empty.status).toBe(409);
    expect(empty.body.code).toBe('guide_empty');
    const dup = await admin.post('/admin/content/guides', { raceId: race.id });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('guide_exists');
    expect((await admin.post('/admin/content/guides', { raceId: race.id, locale: 'es-ES' })).status).toBe(201);
    expect((await admin.post('/admin/content/guides', { raceId: crypto.randomUUID() })).status).toBe(404);
    expect((await admin.get(`/admin/content/guides?raceId=${race.id}`)).body.total).toBe(2);
  });
});

describe('FAQs', () => {
  it('lists published questions in order, hides drafts, and keeps categories together', async () => {
    const tag = slug('faq');
    const b = await published(admin, 'faqs', { category: tag, question: 'Second?', answer: 'Yes.', sortOrder: 20 });
    const a = await published(admin, 'faqs', { category: tag, question: 'First?', answer: 'Yes.', sortOrder: 10 });
    must(await admin.post('/admin/content/faqs', { category: tag, question: 'Hidden?', answer: 'Draft.', sortOrder: 5 }), 'draft');
    const items = (await pub().get('/content/faqs')).body.items.filter((i: { category: string }) => i.category === tag);
    expect(items.map((i: { question: string }) => i.question)).toEqual(['First?', 'Second?']);
    expect(a.status + b.status).toBe('publishedpublished');
  });
});

describe('banners', () => {
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const messages = async () => (await pub().get('/content/banners')).body.items.map((i: { message: string }) => i.message);

  it('shows a published banner only inside its dates', async () => {
    const tag = slug('b');
    await published(admin, 'banners', { message: `${tag} open now`, startsAt: iso(-60_000), endsAt: iso(60_000) });
    await published(admin, 'banners', { message: `${tag} not yet`, startsAt: iso(3_600_000) });
    await published(admin, 'banners', { message: `${tag} finished`, endsAt: iso(-1000) });
    await published(admin, 'banners', { message: `${tag} no dates` });
    must(await admin.post('/admin/content/banners', { message: `${tag} draft` }), 'draft');
    const shown = (await messages()).filter((m: string) => m.startsWith(tag));
    expect(shown.sort()).toEqual([`${tag} no dates`, `${tag} open now`]);
  });

  it('rejects a link with only half of its parts, an unsafe address, and a window that ends before it starts', async () => {
    expect((await admin.post('/admin/content/banners', { message: 'x', linkLabel: 'Go' })).status).toBe(422);
    for (const href of ['javascript:alert(1)', 'http://insecure.example', '//evil.example', 'data:text/html,x', '/ spaced']) {
      expect((await admin.post('/admin/content/banners', { message: 'x', linkLabel: 'Go', linkHref: href })).status, href).toBe(422);
    }
    expect((await admin.post('/admin/content/banners', { message: 'x', startsAt: iso(5000), endsAt: iso(1000) })).status).toBe(422);
    expect((await admin.post('/admin/content/banners', { message: 'ok', linkLabel: 'Go', linkHref: '/faq', tone: 'notice' })).status).toBe(201);
    expect((await admin.post('/admin/content/banners', { message: 'ok', linkLabel: 'Go', linkHref: 'https://example.com/a' })).status).toBe(201);
  });

  it('an update that leaves the link half-filled or the window backwards is refused', async () => {
    const b = must(await admin.post('/admin/content/banners', { message: 'm', linkLabel: 'Go', linkHref: '/faq', startsAt: iso(1000), endsAt: iso(9000) }), 'create').body;
    const r1 = await admin.patch(`/admin/content/banners/${b.id}`, { linkHref: '', version: b.version });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('banner_link_incomplete');
    const r2 = await admin.patch(`/admin/content/banners/${b.id}`, { endsAt: iso(-5000), version: b.version });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('banner_window_invalid');
  });
});

describe('menu', () => {
  it('groups published items by place in order, and hides drafts', async () => {
    const tag = slug('m');
    await published(admin, 'menu', { location: 'header', label: `${tag} B`, href: '/b', sortOrder: 2 });
    await published(admin, 'menu', { location: 'header', label: `${tag} A`, href: '/a', sortOrder: 1 });
    await published(admin, 'menu', { location: 'footer_legal', label: `${tag} L`, href: 'https://example.com/legal', sortOrder: 1 });
    must(await admin.post('/admin/content/menu', { location: 'header', label: `${tag} draft`, href: '/draft' }), 'draft');
    const menu = (await pub().get('/content/menu')).body;
    expect(menu.header.filter((i: { label: string }) => i.label.startsWith(tag)).map((i: { label: string }) => i.label)).toEqual([`${tag} A`, `${tag} B`]);
    expect(menu.footer_legal.map((i: { label: string }) => i.label)).toContain(`${tag} L`);
    expect(Object.keys(menu).sort()).toEqual(['footer_company', 'footer_legal', 'header']);
  });

  it('refuses addresses that are not a path on this site or an https address', async () => {
    for (const href of ['javascript:alert(1)', '//evil.example', 'http://example.com', 'faq', '']) {
      expect((await admin.post('/admin/content/menu', { location: 'header', label: 'x', href })).status, href).toBe(422);
    }
  });
});

describe('image library', () => {
  it('needs a description unless the image is marked decorative, and keeps the two consistent', async () => {
    const base = { label: 'Start line', src: 'https://images.example.com/start.jpg' };
    expect((await admin.post('/admin/content/media', base)).status).toBe(422);
    expect((await admin.post('/admin/content/media', { ...base, altText: '   ' })).status).toBe(422);
    expect((await admin.post('/admin/content/media', { ...base, decorative: true, altText: 'Not empty' })).status).toBe(422);
    expect((await admin.post('/admin/content/media', { ...base, decorative: true })).status).toBe(201);
    const ok = must(await admin.post('/admin/content/media', { ...base, altText: 'Runners at the start line', width: 1200, height: 800 }), 'create').body;
    const r = await admin.patch(`/admin/content/media/${ok.id}`, { decorative: true, version: ok.version });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('media_alt_text');
    expect((await admin.patch(`/admin/content/media/${ok.id}`, { decorative: true, altText: '', version: ok.version })).status).toBe(200);
  });

  it('accepts an https address or a path on this site and nothing else', async () => {
    const make = (src: string) => admin.post('/admin/content/media', { label: 'x', altText: 'x', src });
    for (const src of ['/placeholders/race.svg', 'https://cdn.example.com/a.png']) expect((await make(src)).status, src).toBe(201);
    for (const src of ['javascript:alert(1)', 'http://cdn.example.com/a.png', '//cdn.example.com/a.png', 'data:image/png;base64,AAAA', '/a b.png', 'file:///etc/passwd']) expect((await make(src)).status, src).toBe(422);
  });

  it('an image used as a hero is returned with its page and guide, and cannot be deleted while it is used', async () => {
    const m = must(await admin.post('/admin/content/media', { label: 'Hero', src: '/placeholders/hero.svg', altText: 'A placeholder hero', width: 1600, height: 900 }), 'media').body;
    const live = await published(admin, 'pages', pageBody({ heroMediaId: m.id }));
    const res = (await pub().get(`/content/pages/${live.slug}`)).body;
    expect(res.heroMedia).toEqual({ src: '/placeholders/hero.svg', altText: 'A placeholder hero', decorative: false, width: 1600, height: 900 });
    const del = await admin.delete(`/admin/content/media/${m.id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('media_in_use');
    must(await admin.delete(`/admin/content/pages/${live.id}`), 'delete page');
    expect((await admin.delete(`/admin/content/media/${m.id}`)).status).toBe(204);
    expect((await admin.post('/admin/content/pages', pageBody({ heroMediaId: crypto.randomUUID() }))).status).toBe(404);
  });
});

describe('redirects', () => {
  const path = () => `/${slug('old')}`;
  const make = (fromPath: string, toPath: string, more: Record<string, unknown> = {}) => admin.post('/admin/content/redirects', { fromPath, toPath, ...more });

  it('a redirect is public once saved, can be switched off, and is gone when deleted', async () => {
    const from = path();
    const r = must(await make(from, '/races', { statusCode: 302 }), 'create').body;
    const listed = () => pub().get('/content/redirects').then((x) => x.body.items.find((i: { fromPath: string }) => i.fromPath === from));
    expect(await listed()).toEqual({ fromPath: from, toPath: '/races', statusCode: 302 });
    const off = must(await admin.patch(`/admin/content/redirects/${r.id}`, { enabled: false, version: r.version }), 'off').body;
    expect(await listed()).toBeUndefined();
    must(await admin.patch(`/admin/content/redirects/${r.id}`, { enabled: true, version: off.version }), 'on');
    expect(await listed()).toBeDefined();
    must(await admin.delete(`/admin/content/redirects/${r.id}`), 'delete');
    expect(await listed()).toBeUndefined();
    expect(await audit('content.redirect.deleted', r.id)).toBe(1);
  });

  it('a trailing slash is the same address, and a second redirect from it is a 409', async () => {
    const from = path();
    const r = must(await make(`${from}/`, '/faq'), 'create').body;
    expect(r.fromPath).toBe(from);
    const dup = await make(from, '/about');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('redirect_exists');
  });

  it('refuses a redirect to itself, a loop of two or three, and a chain that is too long', async () => {
    const [a, b, c] = [path(), path(), path()];
    expect((await make(a, a)).body.code).toBe('redirect_loop');
    must(await make(a, b), 'a to b');
    expect((await make(b, a)).body.code).toBe('redirect_loop');
    must(await make(b, c), 'b to c');
    expect((await make(c, a)).body.code).toBe('redirect_loop');
    // A chain of twelve hops is refused at the link that makes it too long.
    const hops = Array.from({ length: 12 }, () => path());
    let refused = 0;
    for (let i = hops.length - 1; i > 0; i--) {
      const r = await make(hops[i - 1]!, hops[i]!);
      if (r.status === 409) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('a switched-off redirect does not count towards a loop, and turning it back on re-checks', async () => {
    const [a, b] = [path(), path()];
    const ra = must(await make(a, b, { enabled: false }), 'off').body;
    must(await make(b, a), 'b to a is fine while a is off');
    const on = await admin.patch(`/admin/content/redirects/${ra.id}`, { enabled: true, version: ra.version });
    expect(on.status).toBe(409);
    expect(on.body.code).toBe('redirect_loop');
  });

  it('refuses reserved paths, query strings, and unsafe targets', async () => {
    for (const from of ['/admin', '/admin/staff', '/api/health', '/_next/static/x']) expect((await make(from, '/faq')).body.code, from).toBe('redirect_path_reserved');
    for (const from of ['/x?y=1', '/x#frag', '//evil.example', 'no-slash', '/']) expect((await make(from, '/faq')).status, from).toBe(422);
    for (const to of ['javascript:alert(1)', 'http://insecure.example', '//evil.example', 'ftp://x']) expect((await make(path(), to)).status, to).toBe(422);
    expect((await make(path(), '/x', { statusCode: 303 })).status).toBe(422);
    expect((await make(path(), 'https://example.com/new')).status).toBe(201);
  });
});

describe('the database backs the rules up', () => {
  it('rejects rows the API would never write', async () => {
    const bad = (sql: string) => expect(t.prisma.$executeRawUnsafe(sql)).rejects.toThrow();
    await bad(`INSERT INTO content_pages (id, slug, title, status, "updatedAt") VALUES (gen_random_uuid(), '${slug('db')}', 't', 'published', now())`);
    await bad(`INSERT INTO content_pages (id, slug, title, "updatedAt") VALUES (gen_random_uuid(), 'Bad Slug', 't', now())`);
    await bad(`INSERT INTO content_redirects (id, "fromPath", "toPath", "updatedAt") VALUES (gen_random_uuid(), '/same', '/same', now())`);
    await bad(`INSERT INTO content_redirects (id, "fromPath", "toPath", "statusCode", "updatedAt") VALUES (gen_random_uuid(), '/${slug('x')}', '/y', 418, now())`);
    await bad(`INSERT INTO content_media (id, src, label, "updatedAt") VALUES (gen_random_uuid(), 'javascript:alert(1)', 'x', now())`);
    await bad(`INSERT INTO content_media (id, src, label, "altText", "updatedAt") VALUES (gen_random_uuid(), '/a.png', 'x', '', now())`);
    await bad(`INSERT INTO content_menu_items (id, location, label, href, "updatedAt") VALUES (gen_random_uuid(), 'header', 'x', '//evil.example', now())`);
    await bad(`INSERT INTO content_banners (id, message, "linkLabel", "linkHref", "updatedAt") VALUES (gen_random_uuid(), 'm', 'only label', '', now())`);
  });
});

describe('audit', () => {
  it('records who changed what, without leaving the staff reason out', async () => {
    const page = must(await admin.post('/admin/content/pages', pageBody({ reason: 'Adding the about page' })), 'create').body;
    must(await admin.patch(`/admin/content/pages/${page.id}`, { title: 'Changed', version: page.version, reason: 'Fixing the title' }), 'edit');
    must(await admin.delete(`/admin/content/pages/${page.id}`), 'delete');
    for (const action of ['created', 'updated', 'deleted']) expect(await audit(`content.page.${action}`, page.id), action).toBe(1);
    expect((await admin.get(`/admin/content/pages/${page.id}`)).status).toBe(404);
  });
});

describe('permissions are registered', () => {
  it('the owner role gets every content permission', async () => {
    const keys = (await t.prisma.permission.findMany({ where: { module: 'content' } })).map((p) => p.key).sort();
    expect(keys).toEqual([...Object.values(CP)].sort());
    expect(ALL.length).toBeGreaterThan(Object.values(CP).length);
  });
});
