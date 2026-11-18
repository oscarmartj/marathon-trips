import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

// Task 8.5: the security headers and the page Content-Security-Policy of the real build (next start), and that the
// policy breaks nothing: public pages, a customer page, the staff panel signed in, and the PDF preview in a new tab.
interface Staff {
  email: string;
  password: string;
  secret: string;
}
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_29 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();

test.use({ actionTimeout: 15_000 });

/** Collects every policy violation and script error the page reports. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply|connect|frame|display)/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test('security_headers_on_every_route_class', async ({ request }) => {
  const get = (path: string) => request.get(path, { maxRedirects: 0 });
  for (const path of ['/', '/races', '/faq', '/account', '/account/sign-in', '/admin/sign-in', '/no-such-page', '/pay']) {
    const h = (await get(path)).headers();
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy'], path).toContain("object-src 'none'");
    expect(h['content-security-policy'], path).not.toContain('unsafe-eval');
  }
  expect((await get('/pay')).headers()['referrer-policy']).toBe('no-referrer');
  expect((await get('/es-ES/pay')).headers()['referrer-policy']).toBe('no-referrer');
  expect((await get('/races')).headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  // A page rendered for each visitor gets a fresh nonce instead of 'unsafe-inline'.
  const a = (await get('/account')).headers()['content-security-policy']!;
  const b = (await get('/account')).headers()['content-security-policy']!;
  expect(a).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(a).not.toBe(b);
  // The API proxy forwards the API's own strict policy, and its own errors are never cached.
  const api = (await get('/api/auth/staff/session')).headers();
  expect(api['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(api['cache-control']).toBe('no-store');
  const bad = await get('/api/a%2Fb');
  expect(bad.status()).toBe(404);
  expect(bad.headers()['cache-control']).toBe('no-store');
});

test('language_redirects_never_leave_the_site', async ({ request }) => {
  for (const path of ['/en-AU//example.com', '/en-AU//example.com/x', '/en-AU/%5Cexample.com', '/en-AU/%2F%2Fexample.com', '//example.com', '/\\example.com']) {
    const res = await request.get(`http://localhost:3000${path}`, { maxRedirects: 0 });
    const location = res.headers()['location'];
    if (location) expect(new URL(location, 'http://localhost:3000').host, `${path} -> ${location}`).toBe('localhost:3000');
  }
});

test('pages_cannot_be_framed_by_another_site', async ({ page }) => {
  await page.setContent('<iframe title="framed" src="http://localhost:3000/account" style="width:600px;height:400px"></iframe>');
  await page.waitForTimeout(2000);
  await expect(page.frameLocator('iframe').getByRole('heading', { level: 1 })).toHaveCount(0);
});

test('public_and_customer_pages_run_under_the_policy', async ({ page }) => {
  const problems = watch(page);
  for (const path of ['/', '/races', '/faq', '/account', '/account/sign-in']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
  }
  // The customer sign-in form is a client component: it only works if the page's scripts ran.
  await page.goto('/account/sign-in');
  await page.locator('#email').fill('csp-check@example.test');
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/auth/customer/magic-link') && r.method() === 'POST');
  await page.locator('form button[type="submit"]').first().click();
  await sent;
  expect(problems).toEqual([]);
});

test('signed_in_panel_and_pdf_preview_run_under_the_policy', async ({ page, context }) => {
  const problems = watch(page);
  const s = owner();
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  for (const path of ['/admin/bookings', '/admin/races', '/admin/templates', '/admin/content']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect((await page.locator('script[nonce]').count()) > 0, path).toBe(true);
  }

  // A document draft and its PDF preview, opened in a new tab as staff do.
  await page.goto('/admin/templates');
  await page.getByLabel('Kind', { exact: true }).selectOption({ label: 'Documents' });
  await page.getByLabel('Template', { exact: true }).selectOption({ label: 'Voucher' });
  await page.getByLabel('Title', { exact: true }).fill(`CSP check ${Date.now()}`);
  await page.getByLabel('Body', { exact: true }).fill('Voucher for {{customerName}}.');
  await page.getByRole('button', { name: 'Save as a new draft', exact: true }).click();
  await expect(page.getByText(/Saved as draft revision \d+\./)).toBeVisible();
  const draftRow = page.getByRole('table', { name: 'Revisions of this template, newest first' }).getByRole('row').filter({ hasText: 'Draft' }).first();
  const pdfResponse = context.waitForEvent('response', (r) => /\/api\/admin\/templates\/document\/[0-9a-f-]{36}\/pdf$/.test(r.url()));
  const tab = context.waitForEvent('page');
  await draftRow.getByRole('link', { name: 'Open PDF preview' }).click();
  const [res, popup] = await Promise.all([pdfResponse, tab]);
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h['content-type']).toContain('application/pdf');
  // The viewer is not handed the API's `default-src 'none'`; the file is still not sniffed or framed.
  expect(h['content-security-policy']).toBeUndefined();
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  await popup.close();
  expect(problems).toEqual([]);
});
