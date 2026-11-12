import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Each spec file signs in with its own owner: the API refuses a TOTP code it has already accepted.
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_9 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
const text = (s: string) => ({ 'en-AU': s });

async function signInStaff(page: Page, s: Staff) {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

// Task 2.5, the phase-2 journey: a customer finds a race, configures a package, sends a request; the team approves it
// in the panel and keeps a note; then the team prepares a quote from the customer's record and the customer accepts it.
// Money is only ever shown as the API returns it. Nothing is charged and no real mail is sent (example.test addresses).
test('search_configure_request_manage', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const apiDir = join(__dirname, '..', '..', 'api');
  const run = Date.now().toString(36);
  const raceName = `Esperance Run ${run}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await signInStaff(page, owner());

  // The shop window: a published race with an open, priced package (set up through the panel's own API).
  const call = async (method: 'post' | 'put' | 'get', path: string, data?: object): Promise<{ status: number; body: any }> => {
    const res: APIResponse = method === 'get' ? await page.request.get(`/api${path}`) : await page.request[method](`/api${path}`, { headers: STATE, data });
    const body = await res.json().catch(() => ({}));
    if (res.status() >= 300) throw new Error(`${method} ${path}: ${res.status()} ${JSON.stringify(body)}`);
    return { status: res.status(), body };
  };
  const race = (await call('post', '/admin/catalogue/races', { slug: `esperance-${run}`, name: text(raceName), countryCode: 'AU', city: 'Perth', timeZone: 'Australia/Perth', raceType: 'road', summary: text('A flat, fast marathon.') })).body;
  const edition = (await call('post', `/admin/catalogue/races/${race.id}/editions`, { year: 2027, startDate: '2027-06-20', endDate: '2027-06-20', dateStatus: 'confirmed' })).body;
  const distance = (await call('post', `/admin/catalogue/races/${race.id}/distances`, { kind: 'marathon', distanceMetres: 42195, name: text('Marathon') })).body;
  const pool = async (kind: string) => (await call('post', `/admin/catalogue/editions/${edition.id}/pools`, { kind, label: `${kind} pool`, capacity: 10, lowStockThreshold: 2 })).body.id as string;
  const [entryPool, roomPool] = [await pool('entry'), await pool('room')];
  const pkg = (await call('post', `/admin/catalogue/editions/${edition.id}/packages`, {
    slug: `weekend-${run}`, name: text(`Race weekend ${run}`), checkInDate: '2027-06-18', checkOutDate: '2027-06-21', balanceDueDate: '2027-04-18', maxTravellers: 4, deposit: { mode: 'per_person', amountMinor: '50000' },
  })).body;
  await call('post', `/admin/catalogue/packages/${pkg.id}/entry-options`, { raceDistanceId: distance.id, entryPoolId: entryPool });
  const hotel = (await call('post', '/admin/catalogue/hotels', { name: 'Riverside Hotel', address: '1 Main Street', city: 'Perth', countryCode: 'AU', starRating: 4 })).body;
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

  // The customer: signs in with a link made for this run, then searches, configures and requests.
  const { email, token } = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-customer.ts'], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' })) as { email: string; token: string };
  const customerContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const shopper = await customerContext.newPage();
  shopper.on('pageerror', (e) => pageErrors.push(e.message));
  await shopper.goto(`/account/sign-in/verify#token=${token}`);
  await shopper.getByRole('button', { name: `Continue as ${email}` }).click();
  await expect(shopper).toHaveURL(/\/account$/);

  await shopper.goto('/races');
  await shopper.getByLabel('Race or city').fill(raceName);
  await shopper.getByLabel('Race or city').press('Enter');
  await shopper.getByRole('link', { name: raceName }).first().click();
  await shopper.getByRole('link', { name: 'Build this package' }).first().click();
  await expect(shopper.getByRole('heading', { name: 'Your price' })).toBeVisible();
  await expect(shopper.getByText('The total includes every mandatory part of the package.')).toBeVisible();
  await shopper.getByRole('link', { name: 'Request this trip' }).click();
  await expect(shopper.getByText('It is not a confirmed booking and you will not be charged now.')).toBeVisible();
  await shopper.getByLabel(/^Given name/).fill('Ada');
  await shopper.getByLabel(/^Family name/).fill('Runner');
  await shopper.getByRole('button', { name: 'Send booking request' }).click();
  await expect(shopper.getByRole('heading', { level: 1, name: 'Request received: this is not a confirmed booking yet' })).toBeVisible();
  const reference = (await shopper.getByText(/^MT-[0-9A-Z]{6}$/).first().textContent())!.trim();
  const confirmationUrl = shopper.url();

  // The team: finds the request in the inbox, approves it and leaves a note.
  await page.goto('/admin/bookings');
  await expect(page.getByRole('heading', { level: 1, name: 'Bookings' })).toBeVisible();
  await page.getByLabel('Search bookings').fill(reference);
  await page.locator('#main').getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: /^All$/ }).click();
  await page.getByRole('link', { name: reference }).click();
  await expect(page.getByRole('heading', { level: 2, name: `Booking ${reference}` })).toBeVisible();
  await page.getByLabel('Add a note').fill('Called to confirm the room type.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Called to confirm the room type.')).toBeVisible();
  await page.getByRole('button', { name: 'Approve request' }).click();
  await expect(page.getByText('Request approved. The customer has been emailed.')).toBeVisible();

  // The customer sees the change.
  await shopper.goto(confirmationUrl);
  await expect(shopper.getByText('We have approved your request.')).toBeVisible();

  // The record: the booking is in the customer's history, and the team prepares a quote from it.
  await page.goto('/admin/customers');
  await page.getByLabel('Search customers').fill(email);
  await page.locator('#main').getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: 'Ada Runner' }).first().click();
  await expect(page.getByRole('link', { name: reference })).toBeVisible();
  await page.getByLabel('Package', { exact: true }).selectOption({ label: `${raceName} 2027, Race weekend ${run}` });
  await page.getByLabel('Room', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/admin\/quotes\/[0-9a-f-]{36}$/);
  const quoteHeading = await page.getByRole('heading', { level: 2, name: /^Quote QT-/ }).textContent();
  const quoteReference = /QT-[0-9A-Z]{6}/.exec(quoteHeading ?? '')![0];
  await page.getByRole('button', { name: 'Send to customer' }).click();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();

  // The customer opens the quote, sees the API's price and accepts it.
  await shopper.goto(`/quotes/${quoteReference}`);
  await expect(shopper.getByText('It is not a confirmed booking yet.')).toBeVisible();
  await expect(shopper.getByText(/\$[0-9,]+\.00/).first()).toBeVisible();
  await shopper.getByRole('button', { name: 'Accept this quote' }).click();
  await expect(shopper).toHaveURL(/\/trips\/requests\/MT-[0-9A-Z]{6}$/);
  await expect(shopper.getByText('We have approved your request.')).toBeVisible();
  await shopper.goto(`/quotes/${quoteReference}`);
  await expect(shopper.getByText('You have accepted this quote.')).toBeVisible();
  await expect(shopper.getByRole('button', { name: 'Accept this quote' })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  await customerContext.close();
});
