import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Each spec file signs in with its own owner: the API refuses a TOTP code it has already accepted.
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_26 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
const text = (s: string) => ({ 'en-AU': s });
const apiDir = join(__dirname, '..', '..', 'api');
const apiEnv = { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' };
const script = (name: string, ...args: string[]): string => execFileSync('pnpm', ['exec', 'tsx', `scripts/${name}.ts`, ...args], { cwd: apiDir, env: apiEnv, encoding: 'utf8' });

async function signInStaff(page: Page, s: Staff) {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** A customer address with a sign-in link token made for this run (no mailbox is read; the address ends in example.test). */
const newCustomer = (): { email: string; token: string } => JSON.parse(script('e2e-customer')) as { email: string; token: string };

async function signInCustomer(browser: Browser, c: { email: string; token: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const page = await context.newPage();
  await page.goto(`/account/sign-in/verify#token=${c.token}`);
  await page.getByRole('button', { name: `Continue as ${c.email}` }).click();
  await expect(page).toHaveURL(/\/account$/);
  return { context, page };
}

/** Phase 5 criterion: no form asks for a passport number or medical data. Reads every field's name, id, label and hint. */
async function expectNoPassportOrMedicalFields(page: Page): Promise<void> {
  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select, textarea')).map((el) => {
      const labels = Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.textContent ?? '');
      return [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), ...labels].join(' ');
    }),
  );
  for (const f of fields) expect(f, `a field on ${page.url()} asks for something it must not`).not.toMatch(/passport|medical|medication|health|dietary|allerg|condition/i);
}

// Task 5.7, the general rehearsal. One customer goes from an alert to a paid, documented booking, in the order phase 5 sells
// a trip: alert (double confirmation), opening, configuration, request, approval, deposit, traveller details, balance by
// payment link, documents. Every payment goes through the payment simulator in test mode; nothing real is charged and no
// amount is typed or sent from the browser. A second customer sees nothing of the booking.
test('rehearsal_alert_to_paid_booking', async ({ page, browser }) => {
  const mark = (s: string) => console.log(`[rehearsal ${new Date().toISOString().slice(11, 19)}] ${s}`);
  test.setTimeout(600_000);
  const run = Date.now().toString(36);
  const raceName = `Fremantle Run ${run}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await signInStaff(page, owner());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: 'post' | 'put' | 'get' | 'patch', path: string, data?: object): Promise<{ status: number; body: any }> => {
    const res: APIResponse = method === 'get' ? await page.request.get(`/api${path}`) : await page.request[method](`/api${path}`, { headers: STATE, data });
    const body = await res.json().catch(() => ({}));
    if (res.status() >= 300) throw new Error(`${method} ${path}: ${res.status()} ${JSON.stringify(body)}`);
    return { status: res.status(), body };
  };

  // The only payment account is the simulator's (test mode, development/test/ci only).
  script('../src/cli', 'payments:simulator-account', '--name', `E2E rehearsal simulator ${run}`);

  // ---- The shop window: a published race whose package is priced but not yet open ----
  const termsWords = `Cancellation clause ${run}.`;
  const pages = (await call('get', '/admin/content/pages?pageSize=100')).body.items as Array<{ id: string; slug: string; locale: string; status: string; version: number }>;
  let terms = pages.find((p) => p.slug === 'terms' && p.locale === 'en-AU');
  if (!terms) terms = (await call('post', '/admin/content/pages', { slug: 'terms', kind: 'legal', title: 'Terms of booking', intro: 'Read these before you pay.', body: `First clause.\n\n${termsWords}` })).body;
  else terms = (await call('patch', `/admin/content/pages/${terms.id}`, { body: `First clause.\n\n${termsWords}`, version: terms.version })).body;
  if (terms!.status !== 'published') await call('post', `/admin/content/pages/${terms!.id}/status`, { status: 'published', version: terms!.version });

  const race = (await call('post', '/admin/catalogue/races', { slug: `fremantle-${run}`, name: text(raceName), countryCode: 'AU', city: 'Perth', timeZone: 'Australia/Perth', raceType: 'road', summary: text('A flat, fast marathon by the sea.') })).body;
  const edition = (await call('post', `/admin/catalogue/races/${race.id}/editions`, { year: 2027, startDate: '2027-06-20', endDate: '2027-06-20', dateStatus: 'confirmed' })).body;
  const distance = (await call('post', `/admin/catalogue/races/${race.id}/distances`, { kind: 'marathon', distanceMetres: 42195, name: text('Marathon') })).body;
  const pool = async (kind: string) => (await call('post', `/admin/catalogue/editions/${edition.id}/pools`, { kind, label: `${kind} pool`, capacity: 10, lowStockThreshold: 2 })).body.id as string;
  const [entryPool, roomPool] = [await pool('entry'), await pool('room')];
  const pkg = (await call('post', `/admin/catalogue/editions/${edition.id}/packages`, {
    slug: `weekend-${run}`, name: text(`Race weekend ${run}`), checkInDate: '2027-06-18', checkOutDate: '2027-06-21', balanceDueDate: '2027-04-18', maxTravellers: 4, deposit: { mode: 'per_person', amountMinor: '50000' },
  })).body;
  await call('post', `/admin/catalogue/packages/${pkg.id}/entry-options`, { raceDistanceId: distance.id, entryPoolId: entryPool });
  const hotel = (await call('post', '/admin/catalogue/hotels', { name: 'Harbour Hotel', address: '1 Main Street', city: 'Perth', countryCode: 'AU', starRating: 4 })).body;
  const linked = (await call('post', `/admin/catalogue/packages/${pkg.id}/hotels`, { hotelId: hotel.id })).body;
  await call('post', `/admin/catalogue/packages/${pkg.id}/hotels/${linked.hotels[0].id}/rooms`, { roomType: 'double', name: text('Double room'), minOccupancy: 1, maxOccupancy: 2, roomPoolId: roomPool });
  await call('put', `/admin/catalogue/packages/${pkg.id}/participation`, { types: ['runner_with_entry', 'supporter'] });
  const full = (await call('get', `/admin/catalogue/packages/${pkg.id}`)).body;
  const roomId = full.hotels[0].rooms[0].id as string;
  const draft = (await call('post', `/admin/pricing/packages/${pkg.id}/price-versions`, { label: 'Rehearsal prices' })).body;
  const rates = await call('put', `/admin/pricing/price-versions/${draft.id}/rates`, {
    version: draft.version,
    roomRates: [{ roomOptionId: roomId, occupancy: 1, pricePerPersonMinor: '80000', extraNightPerPersonMinor: '25000' }, { roomOptionId: roomId, occupancy: 2, pricePerPersonMinor: '50000', extraNightPerPersonMinor: '15000' }],
    participationRates: [{ participationType: 'runner_with_entry', raceDistanceId: distance.id, amountPerPersonMinor: '30000' }, { participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: '2500' }],
    extraRates: [],
  });
  const lists = (await call('get', `/admin/pricing/packages/${pkg.id}/price-versions`)).body;
  await call('post', `/admin/pricing/price-versions/${draft.id}/publish`, { version: rates.body.version, replacesVersionId: lists.lastId ?? null });
  await call('post', `/admin/catalogue/races/${race.id}/status`, { status: 'published', version: race.version });
  const ed = (await call('get', `/admin/catalogue/editions/${edition.id}`)).body;
  await call('post', `/admin/catalogue/editions/${edition.id}/status`, { status: 'announced', version: ed.version });
  const fresh = (await call('get', `/admin/catalogue/packages/${pkg.id}`)).body;
  await call('post', `/admin/catalogue/packages/${pkg.id}/sale-status`, { status: 'coming_soon', version: fresh.version });

  // ---- 1. Alert: two people ask to be told; only one confirms ----
  mark('1. Alert');
  const customer = newCustomer();
  const stranger = `e2e-unconfirmed-${run}@example.test`;
  const visitor = await (await browser.newContext({ baseURL: 'http://localhost:3000' })).newPage();
  visitor.on('pageerror', (e) => pageErrors.push(e.message));
  for (const address of [customer.email, stranger]) {
    await visitor.goto(`/races/fremantle-${run}`);
    await expect(visitor.getByRole('heading', { level: 2, name: 'Be first to know when packages open' })).toBeVisible();
    await expect(visitor.getByRole('link', { name: 'Build this package' })).toHaveCount(0);
    await expectNoPassportOrMedicalFields(visitor);
    await visitor.getByLabel('Email address').fill(address);
    await visitor.getByRole('button', { name: 'Alert me' }).click();
    await expect(visitor.getByText(/Check your inbox\. We have sent a link to confirm your alert\./)).toBeVisible();
  }
  // Nothing counts until it is confirmed: both are pending. The confirmation emails are sent by the real mail service,
  // with a sender that only captures (no mailbox is read and nothing leaves the process).
  const confirmations = JSON.parse(script('e2e-mail', customer.email, stranger)) as { sent: Array<{ to: string; subject: string; token: string | null }> };
  const tokenFor = (address: string) => confirmations.sent.find((m) => m.to === address && /^Confirm your .* alert/.test(m.subject))?.token;
  expect(tokenFor(customer.email)).toBeTruthy();
  expect(tokenFor(stranger)).toBeTruthy();
  const countFor = async () => ((await call('get', '/admin/alerts/subscribers')).body.items as Array<{ slug: string; confirmed: number; pending: number }>).find((r) => r.slug === `fremantle-${run}`);
  expect(await countFor()).toMatchObject({ confirmed: 0, pending: 2 });

  // The customer opens the link in her email and confirms (the second address never does).
  await visitor.goto(`/alerts/confirm#token=${tokenFor(customer.email)}`);
  await visitor.getByRole('button', { name: 'Confirm my alert' }).click();
  await expect(visitor.getByText('Thanks, your alert is confirmed. We will email you when a package opens.')).toBeVisible();
  expect(await countFor()).toMatchObject({ confirmed: 1, pending: 1 });
  // The same link works once.
  const replay = await (await browser.newContext({ baseURL: 'http://localhost:3000' })).newPage();
  await replay.goto(`/alerts/confirm#token=${tokenFor(customer.email)}`);
  await replay.getByRole('button', { name: 'Confirm my alert' }).click();
  await expect(replay.getByText(/This link has expired or has already been used\./)).toBeVisible();

  // ---- 2. Opening: staff opens the package; the confirmed address is emailed and the unconfirmed one is not ----
  mark('2. Opening');
  const toOpen = (await call('get', `/admin/catalogue/packages/${pkg.id}`)).body;
  await call('post', `/admin/catalogue/packages/${pkg.id}/sale-status`, { status: 'open', version: toOpen.version });
  const opened = JSON.parse(script('e2e-mail', customer.email, stranger)) as { sent: Array<{ to: string; subject: string }>; queued: Array<{ to: string; templateKey: string; status: string }> };
  const notices = opened.queued.filter((m) => m.templateKey === 'alerts.package_open');
  expect(notices).toEqual([{ to: customer.email, templateKey: 'alerts.package_open', status: 'sent' }]);
  expect(opened.sent.filter((m) => m.to === customer.email).map((m) => m.subject)).toEqual([`${raceName} 2027: Race weekend ${run} is now open`]);
  expect(opened.sent.filter((m) => m.to === stranger)).toEqual([]);

  // ---- 3. Configuration and request: she signs in, builds her trip and asks for it ----
  mark('3. Configuration and request');
  const a = await signInCustomer(browser, customer);
  a.page.on('pageerror', (e) => pageErrors.push(e.message));
  await a.page.goto(`/races/fremantle-${run}`);
  // The race page is cached for up to a minute; it shows the package as open once it has been rebuilt.
  await expect(async () => {
    await a.page.reload();
    await expect(a.page.getByRole('link', { name: 'Build this package' }).first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  await expect(a.page.getByRole('heading', { level: 2, name: 'Be first to know when packages open' })).toHaveCount(0);
  await a.page.getByRole('link', { name: 'Build this package' }).first().click();
  await expect(a.page.getByRole('heading', { name: 'Your price' })).toBeVisible();
  await expectNoPassportOrMedicalFields(a.page);
  await a.page.getByRole('link', { name: 'Request this trip' }).click();
  await expectNoPassportOrMedicalFields(a.page);
  await a.page.getByLabel(/^Given name/).fill('Ada');
  await a.page.getByLabel(/^Family name/).fill('Runner');
  await a.page.getByRole('button', { name: 'Send booking request' }).click();
  const reference = (await a.page.getByText(/^MT-[0-9A-Z]{6}$/).first().textContent())!.trim();

  await a.page.goto('/account');
  await a.page.getByRole('link', { name: new RegExp(`${raceName} 2027`) }).click();
  await expect(a.page).toHaveURL(new RegExp(`/account/bookings/${reference}$`));
  await expect(a.page.getByText(/It is a request, not a confirmed booking/)).toBeVisible();
  await expect(a.page.getByRole('link', { name: /^Pay .* now$/ })).toHaveCount(0);
  await expect(a.page.getByText('Your documents appear here once your booking is confirmed.')).toBeVisible();

  // ---- 4. Approval: staff finds the request and approves it ----
  mark('4. Approval');
  await page.goto('/admin/bookings');
  await page.getByLabel('Search bookings').fill(reference);
  await page.locator('#main').getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: /^All$/ }).click();
  await page.getByRole('link', { name: reference }).click();
  await page.getByRole('button', { name: 'Approve request' }).click();
  await expect(page.getByText('Request approved. The customer has been emailed.')).toBeVisible();

  // ---- 5. Deposit: from her account, through checkout and the simulator ----
  mark('5. Deposit');
  await a.page.reload();
  await expect(a.page.getByText('Request approved. We are holding your places until the deposit is paid.')).toBeVisible();
  await expect(a.page.getByRole('table', { name: /Payment plan/ })).toBeVisible();
  await a.page.getByRole('link', { name: /^Pay \$[0-9,]+\.[0-9]{2} now$/ }).click();
  await expect(a.page).toHaveURL(new RegExp(`/checkout/${reference}$`));
  await expectNoPassportOrMedicalFields(a.page);
  await a.page.getByRole('checkbox', { name: /I have read and accept the booking terms/ }).check();
  await a.page.getByRole('button', { name: 'Pay now' }).click();
  await expect(a.page).toHaveURL(/\/api\/payments\/simulator\/checkout\//);
  await a.page.getByRole('button', { name: 'Pay (test)' }).click();
  await a.page.getByRole('link', { name: 'Back to the site' }).click();
  await expect(a.page.getByRole('heading', { level: 2, name: 'Payment received' })).toBeVisible({ timeout: 30_000 });
  await a.page.getByRole('link', { name: 'View your booking' }).click();
  await expect(a.page.getByText('Booking confirmed.', { exact: true })).toBeVisible();

  // ---- 6. Traveller details (after the deposit), kept after a reload ----
  mark('6. Traveller details (after the deposit), kept after a reload ');
  await a.page.getByRole('link', { name: 'Add or change traveller details' }).click();
  await expect(a.page).toHaveURL(new RegExp(`/account/bookings/${reference}/travellers$`));
  await expectNoPassportOrMedicalFields(a.page);
  await expect(a.page.getByText(/This form has no place to enter them\./)).toBeVisible();
  await a.page.getByLabel(/^Given name/).first().fill('Ada');
  await a.page.getByLabel(/^Family name/).first().fill('Runner');
  await a.page.getByLabel('Date of birth').first().fill('1985-07-02');
  await a.page.getByLabel('Estimated finish time: hours').first().fill('4');
  await a.page.getByLabel('Estimated finish time: minutes').first().fill('30');
  await a.page.getByLabel('Emergency contact name').first().fill('Sam Runner');
  await a.page.getByLabel('Emergency contact phone').first().fill('0400 123 456');
  await a.page.getByRole('button', { name: 'Save details' }).first().click();
  await expect(a.page.getByText('Details saved.')).toBeVisible();
  await a.page.reload();
  await expect(a.page.getByLabel('Emergency contact name').first()).toHaveValue('Sam Runner');
  await a.page.getByRole('link', { name: 'Back to your booking' }).click();

  // ---- 7. Documents after the deposit: a confirmation and an itinerary as PDF files, no voucher yet ----
  mark('7. Documents after the deposit');
  const confirmation = a.page.getByRole('link', { name: 'Booking confirmation (PDF)' });
  await expect(confirmation).toBeVisible();
  await expect(a.page.getByRole('link', { name: 'Itinerary (PDF)' })).toBeVisible();
  await expect(a.page.getByRole('link', { name: 'Voucher (PDF)' })).toHaveCount(0);
  const pdf = await a.context.request.get((await confirmation.getAttribute('href'))!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // ---- 8. Balance: staff emails a single-use payment link; it is paid with no session at all ----
  mark('8. Balance');
  await page.reload();
  await page.getByRole('button', { name: 'Email a payment link' }).click();
  await expect(page.getByText("Payment link queued for the customer's email.")).toBeVisible();
  const { token } = JSON.parse(script('e2e-payment-link', reference)) as { token: string };
  const holder = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const pay = await holder.newPage();
  pay.on('pageerror', (e) => pageErrors.push(e.message));
  await pay.goto(`/pay#token=${token}`);
  await expect(pay.getByText(/^Amount due now: \$[0-9,]+\.[0-9]{2}$/)).toBeVisible();
  await expect(pay.getByText(reference)).toBeVisible();
  await expect(pay.locator('input[type="text"], input[type="number"], input[type="tel"]')).toHaveCount(0);
  await pay.getByRole('button', { name: 'Pay now' }).click();
  await expect(pay).toHaveURL(/\/api\/payments\/simulator\/checkout\//);
  await pay.getByRole('button', { name: 'Pay (test)' }).click();
  await pay.getByRole('link', { name: 'Back to the site' }).click();
  await expect(pay.getByRole('heading', { level: 2, name: 'Payment received' })).toBeVisible({ timeout: 30_000 });
  const again = await (await browser.newContext({ baseURL: 'http://localhost:3000' })).newPage();
  await again.goto(`/pay#token=${token}`);
  await expect(again.getByText(/This payment link is not valid\./)).toBeVisible();

  // ---- 9. Paid in full: the voucher appears; the account offers no more payments ----
  mark('9. Paid in full');
  await a.page.reload();
  await expect(a.page.getByText('Booking confirmed and paid in full.')).toBeVisible();
  const voucher = a.page.getByRole('link', { name: 'Voucher (PDF)' });
  await expect(voucher).toBeVisible();
  await expect(a.page.getByRole('link', { name: /^Pay .* now$/ })).toHaveCount(0);
  const voucherFile = await a.context.request.get((await voucher.getAttribute('href'))!);
  expect(voucherFile.status()).toBe(200);
  expect((await voucherFile.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // ---- 10. Her data: the export holds her booking and nothing a passport or a doctor would hold ----
  mark('10. Her data');
  await a.page.goto('/account/privacy');
  await expect(a.page.getByRole('heading', { level: 2, name: 'Your data', exact: true })).toBeVisible();
  await expectNoPassportOrMedicalFields(a.page);
  const exported = await a.context.request.get('/api/account/privacy/export');
  expect(exported.status()).toBe(200);
  const exportedText = await exported.text();
  expect(exportedText).toContain(reference);
  expect(exportedText).not.toMatch(/passport|medical|dietary|allerg/i);

  // ---- 11. Another customer sees nothing of the booking ----
  mark('11. Another customer sees nothing of the booking ');
  const b = await signInCustomer(browser, newCustomer());
  await b.page.goto(`/account/bookings/${reference}`);
  await expect(b.page.getByText('We could not show this booking.', { exact: false })).toBeVisible();
  expect((await b.context.request.get(`/api/account/bookings/${reference}`)).status()).toBe(404);
  expect((await b.context.request.get(`/api/account/bookings/${reference}/documents/voucher`)).status()).toBe(404);
  expect((await b.context.request.get(`/api/account/bookings/${reference}/travellers`)).status()).toBe(404);
  await expect(b.page.getByText(reference)).toHaveCount(0);

  // ---- 12. The team's side: the booking is paid, and the alert counts are in the panel ----
  mark('12. The team side');
  await page.goto('/admin/bookings');
  await page.getByLabel('Search bookings').fill(reference);
  await page.locator('#main').getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: /^All$/ }).click();
  await expect(page.getByRole('link', { name: reference })).toBeVisible();
  expect(await countFor()).toMatchObject({ confirmed: 1, pending: 1 });
  await page.goto('/admin');
  await expect(page.getByTestId('dashboard')).toBeVisible();

  expect(pageErrors).toEqual([]);
  await Promise.all([a.context.close(), b.context.close(), holder.close(), again.context().close(), visitor.context().close(), replay.context().close()]);
});
