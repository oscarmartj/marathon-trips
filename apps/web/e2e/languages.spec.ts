import { expect, test } from '@playwright/test';

// Task 8.2: the site serves English (Australia) at plain addresses and Spanish (Spain) under /es-ES, remembers the visitor's
// choice, and tells search engines about both with hreflang. The web server for this suite enables es-ES (playwright.config.ts);
// production stays English-only until ENABLED_LOCALES says otherwise.
const alternates = (page: import('@playwright/test').Page) =>
  page.locator('link[rel="alternate"][hreflang]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('hreflang'), e.getAttribute('href')])));

test('languages_default_plain_other_prefixed_choice_remembered_hreflang_everywhere', async ({ page, request }) => {
  // The default language never shows its tag: the written-out form goes back to the plain address.
  const written = await request.get('/en-AU/races', { maxRedirects: 0 });
  expect(written.status()).toBe(308);
  expect(new URL(written.headers().location ?? '', 'http://localhost:3000').pathname).toBe('/races');

  await page.goto('/races');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-AU');
  await expect(page.getByRole('heading', { level: 1, name: 'Find a race' })).toBeVisible();

  // The same page in Spanish, at its own address, with its own document language.
  await page.goto('/es-ES/races');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-ES');
  await expect(page.getByRole('heading', { level: 1, name: 'Encuentra una carrera' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('link', { name: 'Carreras' })).toHaveAttribute('href', '/es-ES/races');

  // The choice is remembered for plain links; the switcher goes back to English.
  await page.goto('/races');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-ES');
  await page.getByRole('navigation', { name: 'Idioma' }).getByRole('link', { name: 'English (Australia)' }).click();
  await expect(page).toHaveURL(/\/races$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-AU');
  await page.goto('/races');
  await expect(page.getByRole('heading', { level: 1, name: 'Find a race' })).toBeVisible();

  // hreflang: each language at its own address, canonical to itself, x-default the default language. (The race list is
  // rendered per request, so this checks the running settings; pages built ahead pick up a newly enabled language at their
  // next refresh, within a minute.)
  await page.goto('/races');
  expect(await alternates(page)).toEqual({ 'en-AU': 'http://localhost:3000/races', 'es-ES': 'http://localhost:3000/es-ES/races', 'x-default': 'http://localhost:3000/races' });
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'http://localhost:3000/races');
  await page.goto('/es-ES/races');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'http://localhost:3000/es-ES/races');
});

test('languages_unknown_is_404_the_sitemap_lists_both_and_the_panel_stays_english', async ({ page, request }) => {
  expect((await request.get('/fr-FR/races')).status()).toBe(404);

  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).toContain('hreflang="es-ES" href="http://localhost:3000/es-ES/about"');
  expect(sitemap).toContain('hreflang="x-default" href="http://localhost:3000/about"');
  expect(sitemap).toContain('<loc>http://localhost:3000/es-ES/races</loc>');

  // The staff panel is not part of the languages: no prefix, no switcher, English.
  await page.goto('/admin/sign-in');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-AU');
  await expect(page.getByRole('navigation', { name: 'Idioma' })).toHaveCount(0);
});
