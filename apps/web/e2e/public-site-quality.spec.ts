import { expect, test, type Page, type Response } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { auditKeyboard, auditPage, auditReflow, type Finding } from './a11y-audit';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_28 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
const text = (s: string) => ({ 'en-AU': s });

// Task 8.3: accessibility (WCAG 2.2 AA) and performance of the public site, against the production build. The audit helper
// judges what a machine can; a screen reader and a human pass on a real phone stay with Oscar (docs/done/8.3.md).
// Performance budgets are for the pages as served: client JavaScript, styles, third parties, layout shift and caching.
// Compressed bytes of JavaScript per page. The framework alone is about 140 kB; a page with client code also loads the message
// catalogue (about 40 kB). Pages that are plain HTML and text get the tighter budget.
const JS_BUDGET_BYTES = 200_000;
const JS_BUDGET_STATIC_BYTES = 150_000;
const STATIC_PAGES = new Set(['home', 'about', 'faq', 'contact', 'terms', 'privacy', 'complaints', 'content page']);
const CSS_BUDGET_BYTES = 30_000;
const CLS_BUDGET = 0.05;

let raceSlug = '';
let pageSlug = '';
let packageSlug = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const run = Date.now().toString(36);
  const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const page = await context.newPage();
  const s = owner();
  // The API refuses a code it has already accepted; when a failed run restarts the worker, wait for the next 30-second code.
  for (const attempt of [1, 2]) {
    await page.goto('/admin/sign-in');
    await page.getByLabel('Email').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code').fill(code(s.secret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    if (await page.waitForURL(/\/admin$/, { timeout: 5_000 }).then(() => true, () => false)) break;
    if (attempt === 2) throw new Error('could not sign in as the owner');
    await page.waitForTimeout(31_000);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: 'post' | 'put' | 'get', path: string, data?: object): Promise<any> => {
    const res = method === 'get' ? await page.request.get(`/api${path}`) : await page.request[method](`/api${path}`, { headers: STATE, data });
    const body = await res.json().catch(() => ({}));
    if (res.status() >= 300) throw new Error(`${method} ${path}: ${res.status()} ${JSON.stringify(body)}`);
    return body;
  };
  // A published race with an open, priced package, so the race page, the builder and the request page all render.
  raceSlug = `quality-${run}`;
  packageSlug = `weekend-${run}`;
  const race = await call('post', '/admin/catalogue/races', { slug: raceSlug, name: text(`Quality Run ${run}`), countryCode: 'AU', city: 'Perth', timeZone: 'Australia/Perth', raceType: 'road', summary: text('A flat, fast marathon by the sea.') });
  const edition = await call('post', `/admin/catalogue/races/${race.id}/editions`, { year: 2027, startDate: '2027-06-20', endDate: '2027-06-20', dateStatus: 'confirmed' });
  const distance = await call('post', `/admin/catalogue/races/${race.id}/distances`, { kind: 'marathon', distanceMetres: 42195, name: text('Marathon') });
  const pool = async (kind: string) => (await call('post', `/admin/catalogue/editions/${edition.id}/pools`, { kind, label: `${kind} pool`, capacity: 10, lowStockThreshold: 2 })).id as string;
  const [entryPool, roomPool] = [await pool('entry'), await pool('room')];
  const pkg = await call('post', `/admin/catalogue/editions/${edition.id}/packages`, { slug: packageSlug, name: text(`Race weekend ${run}`), checkInDate: '2027-06-18', checkOutDate: '2027-06-21', balanceDueDate: '2027-04-18', maxTravellers: 4, deposit: { mode: 'per_person', amountMinor: '50000' } });
  await call('post', `/admin/catalogue/packages/${pkg.id}/entry-options`, { raceDistanceId: distance.id, entryPoolId: entryPool });
  const hotel = await call('post', '/admin/catalogue/hotels', { name: 'Harbour Hotel', address: '1 Main Street', city: 'Perth', countryCode: 'AU', starRating: 4 });
  const linked = await call('post', `/admin/catalogue/packages/${pkg.id}/hotels`, { hotelId: hotel.id });
  await call('post', `/admin/catalogue/packages/${pkg.id}/hotels/${linked.hotels[0].id}/rooms`, { roomType: 'double', name: text('Double room'), minOccupancy: 1, maxOccupancy: 2, roomPoolId: roomPool });
  await call('put', `/admin/catalogue/packages/${pkg.id}/participation`, { types: ['runner_with_entry', 'supporter'] });
  const full = await call('get', `/admin/catalogue/packages/${pkg.id}`);
  const roomId = full.hotels[0].rooms[0].id as string;
  const draft = await call('post', `/admin/pricing/packages/${pkg.id}/price-versions`, { label: 'Quality prices' });
  const rates = await call('put', `/admin/pricing/price-versions/${draft.id}/rates`, {
    version: draft.version,
    roomRates: [{ roomOptionId: roomId, occupancy: 1, pricePerPersonMinor: '80000', extraNightPerPersonMinor: '25000' }, { roomOptionId: roomId, occupancy: 2, pricePerPersonMinor: '50000', extraNightPerPersonMinor: '15000' }],
    participationRates: [{ participationType: 'runner_with_entry', raceDistanceId: distance.id, amountPerPersonMinor: '30000' }, { participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: '2500' }],
    extraRates: [],
  });
  const lists = await call('get', `/admin/pricing/packages/${pkg.id}/price-versions`);
  await call('post', `/admin/pricing/price-versions/${draft.id}/publish`, { version: rates.version, replacesVersionId: lists.lastId ?? null });
  await call('post', `/admin/catalogue/races/${race.id}/status`, { status: 'published', version: race.version });
  const ed = await call('get', `/admin/catalogue/editions/${edition.id}`);
  await call('post', `/admin/catalogue/editions/${edition.id}/status`, { status: 'announced', version: ed.version });
  const fresh = await call('get', `/admin/catalogue/packages/${pkg.id}`);
  await call('post', `/admin/catalogue/packages/${pkg.id}/sale-status`, { status: 'open', version: fresh.version });
  // A published content-manager page, so that template is audited too.
  pageSlug = `guide-${run}`;
  const guide = await call('post', '/admin/content/pages', { slug: pageSlug, kind: 'general', title: `Race day guide ${run}`, intro: 'What to pack and where to be.', body: 'Arrive early.\n\nBring water.' });
  await call('post', `/admin/content/pages/${guide.id}/status`, { status: 'published', version: guide.version });
  await context.close();
});

function publicPages(): Array<{ name: string; path: string; lang?: string }> {
  return [
    { name: 'home', path: '/' },
    { name: 'race finder', path: '/races' },
    { name: 'race', path: `/races/${raceSlug}` },
    { name: 'package builder', path: `/races/${raceSlug}/build?edition=2027&package=${packageSlug}` },
    { name: 'content page', path: `/pages/${pageSlug}` },
    { name: 'about', path: '/about' },
    { name: 'faq', path: '/faq' },
    { name: 'contact', path: '/contact' },
    { name: 'terms', path: '/legal/terms' },
    { name: 'privacy', path: '/legal/privacy' },
    { name: 'complaints', path: '/legal/complaints' },
    { name: 'customer sign-in', path: '/account/sign-in' },
    { name: 'checkout', path: '/checkout' },
    { name: 'payment link', path: '/pay' },
    { name: 'alert confirmation', path: '/alerts/confirm' },
    { name: 'alert unsubscribe', path: '/alerts/unsubscribe' },
    { name: 'mail unsubscribe', path: '/unsubscribe' },
    // The web server of this suite enables es-ES (playwright.config.ts), so the second language is audited too.
    { name: 'home (es-ES)', path: '/es-ES', lang: 'es-ES' },
    { name: 'race finder (es-ES)', path: '/es-ES/races', lang: 'es-ES' },
    { name: 'race (es-ES)', path: `/es-ES/races/${raceSlug}`, lang: 'es-ES' },
    { name: 'faq (es-ES)', path: '/es-ES/faq', lang: 'es-ES' },
    { name: 'not found', path: '/no-such-page-here' },
  ];
}

const report = (findings: Finding[]) => findings.map((f) => `${f.rule}: ${f.detail}`);

async function open(page: Page, path: string): Promise<Response | null> {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  // Hydration finished before anything is judged.
  await page.waitForLoadState('load');
  return res;
}

test('public_pages_meet_wcag_22_aa_checks', async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  for (const p of publicPages()) {
    await open(page, p.path);
    const findings = [...(await auditPage(page, p.lang)), ...(await auditReflow(page)), ...(await auditKeyboard(page))];
    problems.push(...report(findings).map((f) => `[${p.name} ${p.path}] ${f}`));
  }
  expect.soft(problems, problems.join('\n')).toEqual([]);
});

test('public_pages_are_usable_with_forced_colours_and_reduced_motion', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:3000', forcedColors: 'active', reducedMotion: 'reduce' });
  const page = await context.newPage();
  for (const path of ['/', `/races/${raceSlug}`, `/races/${raceSlug}/build?edition=2027&package=${packageSlug}`, '/faq']) {
    await open(page, path);
    // Buttons, links and fields keep a border or outline when the system replaces the colours (1.4.11 in forced colours).
    const bare = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea'))
        .filter((e) => e.getBoundingClientRect().width > 0)
        .filter((e) => parseFloat(getComputedStyle(e).borderTopWidth) < 1)
        .map((e) => e.outerHTML.slice(0, 80)),
    );
    expect.soft(bare, `${path} has controls with no border in forced colours`).toEqual([]);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    expect.soft(running, `${path} animates under reduced motion`).toBe(0);
  }
  await context.close();
});

test('public_pages_take_200_percent_text_without_losing_content', async ({ browser }) => {
  // Text enlarged to 200% on a desktop window (1.4.4): nothing may need a sideways scroll. 400% zoom (1.4.10) is the
  // 320px-wide check in the audit above.
  const context = await browser.newContext({ baseURL: 'http://localhost:3000', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  for (const path of ['/', `/races/${raceSlug}`, `/races/${raceSlug}/build?edition=2027&package=${packageSlug}`, '/faq']) {
    await open(page, path);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const o = await page.evaluate(() => {
      const c = document.documentElement.clientWidth;
      const wide = Array.from(document.body.querySelectorAll('*')).filter((e) => e.getBoundingClientRect().right > c + 1 && e.getBoundingClientRect().width > 0).slice(0, 4).map((e) => `<${e.tagName.toLowerCase()} class="${e.getAttribute('class') ?? ''}"> ${Math.round(e.getBoundingClientRect().width)}px`);
      return { s: document.documentElement.scrollWidth, c, wide };
    });
    expect.soft(o.s, `${path} scrolls sideways with text at 200%; wide: ${o.wide.join(', ')}`).toBeLessThanOrEqual(o.c + 1);
  }
  await context.close();
});

test('public_pages_stay_light_and_stable', async ({ page }) => {
  test.setTimeout(240_000);
  const origin = 'http://localhost:3000';
  const problems: string[] = [];
  for (const p of publicPages().filter((x) => x.name !== 'not found')) {
    const external: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url());
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number; __lcp: number };
      w.__cls = 0;
      w.__lcp = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const res = await open(page, p.path);
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const bytes = (type: string) => res.filter((r) => (type === 'script' ? r.initiatorType === 'script' || r.name.endsWith('.js') : r.name.endsWith('.css'))).reduce((n, r) => n + (r.encodedBodySize || 0), 0);
      const w = window as unknown as { __cls: number; __lcp: number };
      const imgs = Array.from(document.images);
      return {
        js: bytes('script'),
        css: bytes('css'),
        fonts: res.filter((r) => /\.(woff2?|ttf|otf)(\?|$)/.test(r.name)).length,
        cls: w.__cls,
        lcp: w.__lcp,
        noSize: imgs.filter((i) => !(i.getAttribute('width') && i.getAttribute('height')) && !getComputedStyle(i).aspectRatio.match(/\d/)).map((i) => i.getAttribute('src') ?? ''),
        eagerBelowFold: imgs.filter((i) => i.getBoundingClientRect().top > innerHeight * 1.5 && i.loading !== 'lazy').map((i) => i.getAttribute('src') ?? ''),
      };
    });
    const tag = `[${p.name} ${p.path}]`;
    if (process.env.PW_METRICS) problems.push(`${tag} js ${m.js} B, css ${m.css} B, layout shift ${m.cls.toFixed(3)}, LCP ${Math.round(m.lcp)} ms (metrics)`);
    const jsBudget = STATIC_PAGES.has(p.name) ? JS_BUDGET_STATIC_BYTES : JS_BUDGET_BYTES;
    if (m.js > jsBudget) problems.push(`${tag} ${m.js} bytes of JavaScript, budget ${jsBudget}`);
    if (m.css > CSS_BUDGET_BYTES) problems.push(`${tag} ${m.css} bytes of CSS, budget ${CSS_BUDGET_BYTES}`);
    if (m.fonts > 0) problems.push(`${tag} downloads ${m.fonts} font files (system fonts only)`);
    if (m.cls > CLS_BUDGET) problems.push(`${tag} layout shift ${m.cls.toFixed(3)}, budget ${CLS_BUDGET}`);
    if (m.lcp > 2500) problems.push(`${tag} largest contentful paint ${Math.round(m.lcp)} ms, budget 2500`);
    if (m.noSize.length) problems.push(`${tag} images without a reserved size: ${m.noSize.join(', ')}`);
    if (m.eagerBelowFold.length) problems.push(`${tag} images far below the fold that load eagerly: ${m.eagerBelowFold.join(', ')}`);
    if (external.length) problems.push(`${tag} third-party requests: ${[...new Set(external)].join(', ')}`);
    if (res && res.status() === 200) {
      const h = res.headers();
      if (h['content-encoding'] === undefined && (h['content-type'] ?? '').startsWith('text/html') && Number(h['content-length'] ?? 0) > 10_000) problems.push(`${tag} HTML over 10 kB served without compression`);
    }
    page.removeAllListeners('request');
  }
  expect.soft(problems, problems.join('\n')).toEqual([]);
});

test('public_pages_are_cached_and_static_assets_are_immutable', async ({ page, request }) => {
  // The pages that never depend on the visitor are prerendered and cacheable by a CDN for a minute (incremental regeneration).
  for (const path of ['/', '/about', '/faq', '/contact', '/legal/terms', '/legal/privacy', '/legal/complaints', `/races/${raceSlug}`, `/pages/${pageSlug}`]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['cache-control'] ?? '', `${path} is not cacheable`).toMatch(/s-maxage=\d+/);
  }
  // Built assets are fingerprinted, so a year-long immutable cache is safe.
  await open(page, '/');
  const assets = await page.evaluate(() => Array.from(document.querySelectorAll('script[src], link[rel="stylesheet"]')).map((e) => (e as HTMLScriptElement).src || (e as HTMLLinkElement).href));
  expect(assets.length).toBeGreaterThan(0);
  for (const url of assets) {
    const res = await request.get(url);
    expect(res.headers()['cache-control'] ?? '', url).toMatch(/immutable/);
  }
});
