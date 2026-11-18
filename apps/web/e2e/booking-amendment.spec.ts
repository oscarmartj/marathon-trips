import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_23 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
const text = (s: string) => ({ 'en-AU': s });
const apiDir = join(__dirname, '..', '..', 'api');
const env = { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' };

async function signInStaff(page: Page, s: Staff) {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function signedInCustomer(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const { token, email } = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-customer.ts'], { cwd: apiDir, env, encoding: 'utf8' })) as { email: string; token: string };
  const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const page = await context.newPage();
  await page.goto(`/account/sign-in/verify#token=${token}`);
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await expect(page).toHaveURL(/\/account$/);
  return { context, page };
}

/** Pays the next item from the booking page through the simulator's hosted page; back on the booking page after. */
async function payFromBooking(p: Page, reference: string, amount: RegExp, acceptTerms: boolean) {
  await p.getByRole('link', { name: amount }).click();
  await expect(p).toHaveURL(new RegExp(`/checkout/${reference}$`));
  if (acceptTerms) await p.getByRole('checkbox', { name: /I have read and accept the booking terms/ }).check();
  await p.getByRole('button', { name: 'Pay now' }).click();
  await expect(p).toHaveURL(/\/api\/payments\/simulator\/checkout\//);
  await p.getByRole('button', { name: 'Pay (test)' }).click();
  await p.getByRole('link', { name: 'Back to the site' }).click();
  await expect(p.getByRole('heading', { level: 2, name: 'Payment received' })).toBeVisible({ timeout: 30_000 });
  await p.getByRole('link', { name: 'View your booking' }).click();
  await expect(p).toHaveURL(new RegExp(`/account/bookings/${reference}$`));
}

// Task 6.3: a customer with the deposit paid adds an extra night online. The API prices the change on the prices she
// booked at, she accepts the difference, and pays it through the simulator; the panel shows the change. Nothing is
// computed or sent as an amount by the browser; another customer cannot open the change page.
test('booking_amendment_customer_change_and_payment', async ({ page, browser }) => {
  test.setTimeout(480_000);
  const run = Date.now().toString(36);
  const raceName = `Margaret River Run ${run}`;
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

  execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', 'payments:simulator-account', '--name', `E2E simulator ${run}`], { cwd: apiDir, env, encoding: 'utf8' });
  const pages = (await call('get', '/admin/content/pages?pageSize=100')).body.items as Array<{ id: string; slug: string; locale: string; status: string; version: number }>;
  let terms = pages.find((p) => p.slug === 'terms' && p.locale === 'en-AU');
  if (!terms) terms = (await call('post', '/admin/content/pages', { slug: 'terms', kind: 'legal', title: 'Terms of booking', intro: 'Read these before you pay.', body: `First clause.\n\nChanges clause ${run}.` })).body;
  else terms = (await call('patch', `/admin/content/pages/${terms.id}`, { body: `First clause.\n\nChanges clause ${run}.`, version: terms.version })).body;
  if (terms!.status !== 'published') await call('post', `/admin/content/pages/${terms!.id}/status`, { status: 'published', version: terms!.version });

  // Online changes are off by default (they are Oscar's switch): this run turns them on.
  const settings = (await call('get', '/admin/settings')).body as Array<{ key: string; version?: number }>;
  const current = settings.find((s) => s.key === 'customerAmendmentsEnabled');
  await call('put', '/admin/settings/customerAmendmentsEnabled', { value: true, version: current?.version ?? 0, reason: 'E2E run' });

  const race = (await call('post', '/admin/catalogue/races', { slug: `margaret-${run}`, name: text(raceName), countryCode: 'AU', city: 'Margaret River', timeZone: 'Australia/Perth', raceType: 'road', summary: text('Vineyards.') })).body;
  const edition = (await call('post', `/admin/catalogue/races/${race.id}/editions`, { year: 2027, startDate: '2027-06-20', endDate: '2027-06-20', dateStatus: 'confirmed' })).body;
  const distance = (await call('post', `/admin/catalogue/races/${race.id}/distances`, { kind: 'marathon', distanceMetres: 42195, name: text('Marathon') })).body;
  const pool = async (kind: string) => (await call('post', `/admin/catalogue/editions/${edition.id}/pools`, { kind, label: `${kind} pool`, capacity: 10, lowStockThreshold: 2 })).body.id as string;
  const [entryPool, roomPool] = [await pool('entry'), await pool('room')];
  const pkg = (await call('post', `/admin/catalogue/editions/${edition.id}/packages`, {
    slug: `weekend-${run}`, name: text(`Race weekend ${run}`), checkInDate: '2027-06-18', checkOutDate: '2027-06-21', balanceDueDate: '2027-04-18', maxTravellers: 4,
    maxExtraNightsBefore: 1, maxExtraNightsAfter: 2, deposit: { mode: 'per_person', amountMinor: '50000' },
  })).body;
  await call('post', `/admin/catalogue/packages/${pkg.id}/entry-options`, { raceDistanceId: distance.id, entryPoolId: entryPool });
  const hotel = (await call('post', '/admin/catalogue/hotels', { name: 'Vineyard Hotel', address: '1 Main Street', city: 'Margaret River', countryCode: 'AU', starRating: 4 })).body;
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

  // ---- Customer A requests the trip (a runner and a supporter in the double: $1,325.00); the team approves it ----
  const a = await signedInCustomer(browser);
  a.page.on('pageerror', (e) => pageErrors.push(e.message));
  const req = await a.page.request.post('/api/booking-requests', {
    headers: { ...STATE, 'Idempotency-Key': randomUUID() },
    data: { packageId: pkg.id, rooms: [{ roomOptionId: roomId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: distance.id }, { participationType: 'supporter' }] }], contact: { givenName: 'Ada', familyName: 'Runner', phone: '+61 400 000 000', countryOfResidence: 'AU' } },
  });
  expect(req.status()).toBe(201);
  const reference = (await req.json()).reference as string;
  const list = (await call('get', `/admin/bookings?status=requested&packageId=${pkg.id}`)).body.items as Array<{ id: string; reference: string }>;
  const bookingId = list.find((b) => b.reference === reference)!.id;
  const b0 = (await call('get', `/admin/bookings/${bookingId}`)).body;
  await call('post', `/admin/bookings/${bookingId}/approve`, { version: b0.version });

  // ---- She pays the deposit ($1,000.00) from her account ----
  await a.page.goto(`/account/bookings/${reference}`);
  await payFromBooking(a.page, reference, /^Pay \$1,000\.00 now$/, true);
  await expect(a.page.getByText('Booking confirmed.', { exact: true })).toBeVisible();

  // ---- She adds an extra night after the race: the API prices it ($300.00 more for two) ----
  await expect(a.page.getByRole('heading', { level: 2, name: 'Changes to this booking' })).toBeVisible();
  await a.page.getByRole('link', { name: 'Change nights or extras' }).click();
  await expect(a.page).toHaveURL(new RegExp(`/account/bookings/${reference}/change$`));
  await a.page.getByLabel('Extra nights after').selectOption('1');
  await a.page.getByRole('button', { name: 'Show the new price' }).click();
  const preview = a.page.getByRole('region', { name: 'The new price' });
  await expect(preview).toBeVisible();
  await expect(preview.getByText('$1,325.00')).toBeVisible();
  await expect(preview.getByText('$1,625.00')).toBeVisible();
  await expect(preview.getByText('$300.00')).toBeVisible();
  await a.page.getByRole('button', { name: 'Make this change' }).click();
  await expect(a.page.getByText('Tick the box to accept the new price.')).toBeVisible();
  await a.page.getByRole('checkbox', { name: 'I accept the new price and want to make this change' }).check();
  await a.page.getByRole('button', { name: 'Make this change' }).click();
  await expect(a.page).toHaveURL(new RegExp(`/account/bookings/${reference}\\?changed=1$`));
  await expect(a.page.getByText(/changed by you \(extra nights\)\. Total \$1,325\.00 → \$1,625\.00, a difference of \$300\.00\./)).toBeVisible();

  // ---- She pays what the change added, first in the plan (due within days) ----
  await payFromBooking(a.page, reference, /^Pay \$300\.00 now$/, false);
  await expect(a.page.getByText('Still to pay: $325.00')).toBeVisible();

  // ---- The panel shows the change ----
  await page.goto(`/admin/bookings/${bookingId}`);
  await expect(page.getByRole('heading', { name: 'Changes' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Changes to this booking' }).getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('cell', { name: 'the customer' })).toBeVisible();

  // ---- Another customer sees nothing ----
  const b = await signedInCustomer(browser);
  await b.page.goto(`/account/bookings/${reference}/change`);
  await expect(b.page.getByText('We could not show this booking. Sign in with the email address you used to book.')).toBeVisible();
  await expect(b.page.getByRole('button', { name: 'Show the new price' })).toHaveCount(0);
  const other = await b.page.request.post(`/api/account/bookings/${reference}/amendments/preview`, { headers: STATE, data: { expectedSnapshotVersion: 2, extraNightsBefore: 0, extraNightsAfter: 2, extras: [] } });
  expect(other.status()).toBe(404);

  await call('put', '/admin/settings/customerAmendmentsEnabled', { value: false, version: ((await call('get', '/admin/settings')).body as Array<{ key: string; version?: number }>).find((s) => s.key === 'customerAmendmentsEnabled')?.version ?? 0, reason: 'E2E run done' });
  expect(pageErrors).toEqual([]);
  await a.context.close();
  await b.context.close();
});
