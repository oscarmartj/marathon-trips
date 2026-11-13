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
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_17 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
const text = (s: string) => ({ 'en-AU': s });
const apiDir = join(__dirname, '..', '..', 'api');

async function signInStaff(page: Page, s: Staff) {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** A customer with a session made for this run (no mailbox is read; the address ends in example.test). */
async function signedInCustomer(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const { token, email } = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-customer.ts'], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' })) as { email: string; token: string };
  const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const page = await context.newPage();
  await page.goto(`/account/sign-in/verify#token=${token}`);
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await expect(page).toHaveURL(/\/account$/);
  return { context, page };
}

// Task 3.5, the checkout journey against the payment simulator: the customer opens checkout from her approved request,
// sees only the methods the API offers, cannot pay without accepting the terms, accepts them, pays on the provider's own
// page (the simulator's), comes back and is told by the API that the payment was received. A second customer is declined.
// Nothing real is charged: the only account is the simulator's, and the amount is never typed or sent from the browser.
test('checkout_with_terms_and_the_simulator', async ({ page, browser }) => {
  test.setTimeout(420_000);
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
  execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', 'payments:simulator-account', '--name', `E2E simulator ${run}`], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' });

  // The booking terms: the published "terms" page, with words only this run uses.
  const termsWords = `Cancellation clause ${run}.`;
  const pages = (await call('get', '/admin/content/pages?pageSize=100')).body.items as Array<{ id: string; slug: string; locale: string; status: string; version: number }>;
  let terms = pages.find((p) => p.slug === 'terms' && p.locale === 'en-AU');
  if (!terms) terms = (await call('post', '/admin/content/pages', { slug: 'terms', kind: 'legal', title: 'Terms of booking', intro: 'Read these before you pay.', body: `First clause.\n\n${termsWords}` })).body;
  else terms = (await call('patch', `/admin/content/pages/${terms.id}`, { body: `First clause.\n\n${termsWords}`, version: terms.version })).body;
  if (terms!.status !== 'published') await call('post', `/admin/content/pages/${terms!.id}/status`, { status: 'published', version: terms!.version });

  // The shop window: a published race with an open, priced package.
  const race = (await call('post', '/admin/catalogue/races', { slug: `fremantle-${run}`, name: text(raceName), countryCode: 'AU', city: 'Perth', timeZone: 'Australia/Perth', raceType: 'road', summary: text('A flat, fast marathon.') })).body;
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
  const draft = (await call('post', `/admin/pricing/packages/${pkg.id}/price-versions`, { label: 'E2E prices' })).body;
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
  await call('post', `/admin/catalogue/packages/${pkg.id}/sale-status`, { status: 'open', version: fresh.version });

  /** A customer finds the race, requests the trip, and the team approves the request in the panel. Returns the reference. */
  async function approvedRequest(shopper: Page): Promise<string> {
    shopper.on('pageerror', (e) => pageErrors.push(e.message));
    await shopper.goto('/races');
    await shopper.getByLabel('Race or city').fill(raceName);
    await shopper.getByLabel('Race or city').press('Enter');
    await shopper.getByRole('link', { name: raceName }).first().click();
    await shopper.getByRole('link', { name: 'Build this package' }).first().click();
    await expect(shopper.getByRole('heading', { name: 'Your price' })).toBeVisible();
    await shopper.getByRole('link', { name: 'Request this trip' }).click();
    await shopper.getByLabel(/^Given name/).fill('Ada');
    await shopper.getByLabel(/^Family name/).fill('Runner');
    await shopper.getByRole('button', { name: 'Send booking request' }).click();
    await expect(shopper.getByRole('heading', { level: 1, name: 'Request received: this is not a confirmed booking yet' })).toBeVisible();
    const reference = (await shopper.getByText(/^MT-[0-9A-Z]{6}$/).first().textContent())!.trim();
    // Before approval there is no way to pay: no link, and the checkout address says so.
    await expect(shopper.getByRole('link', { name: 'Continue to payment' })).toHaveCount(0);
    await shopper.goto(`/checkout/${reference}`);
    await expect(shopper.getByText('This booking cannot take a payment right now.')).toBeVisible();

    await page.goto('/admin/bookings');
    await page.getByLabel('Search bookings').fill(reference);
    await page.locator('#main').getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: /^All$/ }).click();
    await page.getByRole('link', { name: reference }).click();
    await page.getByRole('button', { name: 'Approve request' }).click();
    await expect(page.getByText('Request approved. The customer has been emailed.')).toBeVisible();
    return reference;
  }

  // ---- Customer one: accepts the terms, pays at the simulator, comes back and is told it was received ----
  const one = await signedInCustomer(browser);
  const ref1 = await approvedRequest(one.page);
  await one.page.goto(`/trips/requests/${ref1}`);
  await expect(one.page.getByText('We have approved your request.')).toBeVisible();
  await one.page.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(one.page).toHaveURL(new RegExp(`/checkout/${ref1}$`));
  await expect(one.page.getByRole('heading', { level: 1, name: 'Pay for your booking' })).toBeVisible();

  // The plan and the amount come from the API; the page offers only methods the API lists for this country.
  await expect(one.page.getByText(/^You will pay \$[0-9,]+\.[0-9]{2} now\.$/)).toBeVisible();
  await expect(one.page.getByRole('radio', { name: 'Credit or debit card' })).toBeChecked();
  await expect(one.page.getByRole('radio', { name: 'Pay later' })).toHaveCount(0);
  await expect(one.page.getByRole('radio', { name: 'PayID or bank transfer' })).toHaveCount(0);
  await expect(one.page.getByText('We never see or store them.')).toBeVisible();
  // There is no field for a card number or an amount on our page.
  await expect(one.page.locator('input[type="text"], input[type="number"], input[type="tel"]')).toHaveCount(0);

  // The terms are shown with their version, and paying needs them accepted.
  await expect(one.page.getByRole('region', { name: 'Text of the booking terms' })).toContainText(termsWords);
  await expect(one.page.getByText(/^Terms version [0-9]+$/)).toBeVisible();
  await one.page.getByRole('button', { name: 'Pay now' }).click();
  await expect(one.page.locator('.form-error')).toHaveText('Tick the box to accept the booking terms before you pay.');
  await expect(one.page).toHaveURL(new RegExp(`/checkout/${ref1}$`));
  // Nothing was recorded by that click.
  expect((await (await one.context.request.get(`/api/booking-requests/${ref1}/checkout-terms`)).json()).acceptedAt).toBeNull();
  expect((await (await one.context.request.get(`/api/booking-requests/${ref1}/payment-plan`)).json()).liveAttempt).toBeNull();

  await one.page.getByRole('checkbox', { name: /I have read and accept the booking terms/ }).check();
  await one.page.getByRole('button', { name: 'Pay now' }).click();

  // The provider's own page (the simulator's): no card details are asked for.
  await expect(one.page).toHaveURL(/\/api\/payments\/simulator\/checkout\//);
  await expect(one.page.getByRole('heading', { level: 1, name: 'Test payment' })).toBeVisible();
  await one.page.getByRole('button', { name: 'Pay (test)' }).click();
  await expect(one.page.getByRole('heading', { level: 1, name: 'Payment approved' })).toBeVisible();
  await one.page.getByRole('link', { name: 'Back to the site' }).click();

  // The return page asks the API; only the API's answer says the payment was received.
  await expect(one.page).toHaveURL(new RegExp(`/payments/return\\?ref=${ref1}$`));
  await expect(one.page.getByRole('heading', { level: 2, name: 'Payment received' })).toBeVisible({ timeout: 30_000 });
  await expect(one.page.getByText(/Your deposit is paid\.|Your booking is confirmed\./)).toBeVisible();

  // The record: the acceptance has a version and a date, and the plan shows the deposit paid.
  const accepted = await (await one.context.request.get(`/api/booking-requests/${ref1}/checkout-terms`)).json();
  expect(accepted.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(typeof accepted.version).toBe('number');
  const plan = await (await one.context.request.get(`/api/booking-requests/${ref1}/payment-plan`)).json();
  expect(plan.items[0].paidMinor).toBe(plan.items[0].amountMinor);
  expect(plan.liveAttempt).toBeNull();
  await one.page.goto(`/checkout/${ref1}`);
  await expect(one.page.getByText(/^You accepted these terms on /)).toBeVisible();

  // ---- Customer two: declined at the simulator, told so, and can try again ----
  const two = await signedInCustomer(browser);
  const ref2 = await approvedRequest(two.page);
  await two.page.goto(`/checkout/${ref2}`);
  await two.page.getByRole('checkbox', { name: /I have read and accept the booking terms/ }).check();
  await two.page.getByRole('button', { name: 'Pay now' }).click();
  await expect(two.page).toHaveURL(/\/api\/payments\/simulator\/checkout\//);
  await two.page.getByRole('button', { name: 'Decline (test)' }).click();
  await expect(two.page.getByRole('heading', { level: 1, name: 'Payment declined' })).toBeVisible();
  await two.page.getByRole('link', { name: 'Back to the site' }).click();
  await expect(two.page.getByRole('heading', { level: 2, name: 'Your payment did not go through' })).toBeVisible({ timeout: 30_000 });
  await expect(two.page.getByText('Nothing has been charged.')).toBeVisible();
  await expect(two.page.getByText('Payment received')).toHaveCount(0);
  await two.page.getByRole('link', { name: 'Back to checkout' }).click();
  await expect(two.page.getByRole('button', { name: 'Pay now' })).toBeVisible();

  // ---- A visitor who is not signed in, and an address that is not a booking ----
  const visitor = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const anon = await visitor.newPage();
  await anon.goto(`/checkout/${ref1}`);
  await expect(anon.getByRole('heading', { level: 1, name: 'Sign in to pay' })).toBeVisible();
  await expect(anon.getByText('Pay now')).toHaveCount(0);
  await anon.goto(`/payments/return?ref=${ref1}`);
  await expect(anon.getByText('Your session has ended. Sign in to see this payment.')).toBeVisible();
  await anon.goto('/payments/return?ref=not-a-reference');
  await expect(anon.getByRole('heading', { level: 1, name: 'We could not show this payment' })).toBeVisible();
  // Customer one cannot read customer two's checkout.
  await one.page.goto(`/checkout/${ref2}`);
  await expect(one.page.getByRole('heading', { level: 1, name: 'Sign in to pay' })).toBeVisible();

  expect(pageErrors).toEqual([]);
  await Promise.all([one.context.close(), two.context.close(), visitor.close()]);
});
