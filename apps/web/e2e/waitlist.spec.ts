import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 15 (see global-setup.ts). Each spec file signs in with its own owner: the API refuses a TOTP code it has already accepted.
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_15 ?? '{}') as Staff;
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

// Task 6.5: a full package takes a waiting list; when the holder's request is cancelled the first person waiting is
// offered the places, sees the engine's price, and accepting sends a booking request. The panel lists the entry.
test('waitlist_offer_promoted_on_cancellation_and_accepted', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const apiDir = join(__dirname, '..', '..', 'api');
  const run = Date.now().toString(36);
  const raceName = `Fremantle Run ${run}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await signInStaff(page, owner());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: 'post' | 'put' | 'get', path: string, data?: object): Promise<{ status: number; body: any }> => {
    const res: APIResponse = method === 'get' ? await page.request.get(`/api${path}`) : await page.request[method](`/api${path}`, { headers: STATE, data });
    const body = await res.json().catch(() => ({}));
    if (res.status() >= 300) throw new Error(`${method} ${path}: ${res.status()} ${JSON.stringify(body)}`);
    return { status: res.status(), body };
  };
  const race = (await call('post', '/admin/catalogue/races', { slug: `fremantle-${run}`, name: text(raceName), countryCode: 'AU', city: 'Perth', timeZone: 'Australia/Perth', raceType: 'road', summary: text('A flat, fast marathon.') })).body;
  const edition = (await call('post', `/admin/catalogue/races/${race.id}/editions`, { year: 2027, startDate: '2027-06-20', endDate: '2027-06-20', dateStatus: 'confirmed' })).body;
  const distance = (await call('post', `/admin/catalogue/races/${race.id}/distances`, { kind: 'marathon', distanceMetres: 42195, name: text('Marathon') })).body;
  // One place of each: the first request takes everything.
  const pool = async (kind: string) => (await call('post', `/admin/catalogue/editions/${edition.id}/pools`, { kind, label: `${kind} pool`, capacity: 1, lowStockThreshold: 0 })).body.id as string;
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

  const signInCustomer = async () => {
    const { email, token } = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-customer.ts'], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' })) as { email: string; token: string };
    const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const p = await context.newPage();
    p.on('pageerror', (e) => pageErrors.push(e.message));
    await p.goto(`/account/sign-in/verify#token=${token}`);
    await p.getByRole('button', { name: `Continue as ${email}` }).click();
    await expect(p).toHaveURL(/\/account$/);
    return { email, page: p, context };
  };

  // The holder takes the only places, then the team marks the package sold out.
  const holder = await signInCustomer();
  const held = await holder.page.request.post('/api/booking-requests', {
    headers: { ...STATE, 'Idempotency-Key': randomUUID() },
    data: { packageId: pkg.id, rooms: [{ roomOptionId: roomId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: distance.id }, { participationType: 'supporter' }] }], contact: { givenName: 'Holly', familyName: 'Holder', countryOfResidence: 'AU' } },
  });
  expect(held.status()).toBe(201);
  const holderReference = ((await held.json()) as { reference: string }).reference;
  const afterHold = (await call('get', `/admin/catalogue/packages/${pkg.id}`)).body;
  await call('post', `/admin/catalogue/packages/${pkg.id}/sale-status`, { status: 'sold_out', version: afterHold.version });

  // The person waiting: the race page offers the waiting list, not a booking.
  const waiter = await signInCustomer();
  await waiter.page.goto('/races');
  await waiter.page.getByLabel('Race or city').fill(raceName);
  await waiter.page.getByLabel('Race or city').press('Enter');
  await waiter.page.getByRole('link', { name: raceName }).first().click();
  await expect(waiter.page.getByRole('link', { name: 'Build this package' })).toHaveCount(0);
  await waiter.page.getByRole('link', { name: 'Join the waiting list' }).first().click();
  await expect(waiter.page.getByText('This trip is full at the moment. Choose what you would like')).toBeVisible();
  await waiter.page.getByRole('link', { name: 'Join the waiting list' }).click();
  await expect(waiter.page.getByText('This joins the waiting list for it: it is not a booking request')).toBeVisible();
  await waiter.page.getByLabel(/^Given name/).fill('Wendy');
  await waiter.page.getByLabel(/^Family name/).fill('Waiter');
  await waiter.page.getByRole('button', { name: 'Join the waiting list' }).click();
  await expect(waiter.page.getByRole('heading', { name: 'You are on the waiting list for this trip: this is not a booking request' })).toBeVisible();

  // The panel lists the entry as waiting.
  await page.goto('/admin/waitlist');
  await expect(page.getByRole('heading', { level: 1, name: 'Waiting list' })).toBeVisible();
  await page.getByLabel('Package id (optional)').fill(pkg.id);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  const row = page.getByRole('row').filter({ hasText: waiter.email });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Waiting');
  await expect(row).toContainText('Package sold out');

  // The holder's request is cancelled in the panel: the places come back and are offered to the person waiting.
  const holderBooking = (await call('get', `/admin/bookings?q=${holderReference}`)).body.items[0] as { id: string; version: number };
  // Task 6.4: the panel cancels with the digest of the quote it showed.
  const cancelQuote = (await call('get', `/admin/bookings/${holderBooking.id}/cancellation-quote`)).body as { quoteDigest: string };
  await call('post', `/admin/bookings/${holderBooking.id}/cancel`, { version: holderBooking.version, reason: 'Customer asked to cancel', quoteDigest: cancelQuote.quoteDigest });
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('row').filter({ hasText: waiter.email })).toContainText('Offered');

  // The offer page shows the engine's price and both choices; nothing says it is a confirmed booking.
  const entry = ((await call('get', `/admin/waitlist?status=offered&packageId=${pkg.id}`)).body.items as Array<{ id: string; email: string }>).find((e) => e.email === waiter.email.toLowerCase())!;
  await waiter.page.goto(`/waitlist/${entry.id}`);
  await expect(waiter.page.getByText('A place has come up and we are holding it for you.')).toBeVisible();
  await expect(waiter.page.getByText('It is not a confirmed booking and you will not be charged now.')).toBeVisible();
  await expect(waiter.page.getByText(/\$[0-9,]+\.00/).first()).toBeVisible();
  await waiter.page.getByRole('button', { name: 'Accept the offer' }).click();
  await expect(waiter.page).toHaveURL(/\/trips\/requests\/MT-[0-9A-Z]{6}$/);
  await waiter.page.goto(`/waitlist/${entry.id}`);
  await expect(waiter.page.getByText('You accepted the offer. It is now a booking request that we will review.')).toBeVisible();
  await expect(waiter.page.getByRole('button', { name: 'Accept the offer' })).toHaveCount(0);

  // Someone else cannot read the offer.
  await holder.page.goto(`/waitlist/${entry.id}`);
  await expect(holder.page.getByRole('heading', { name: 'We could not show this' })).toBeVisible();

  expect(pageErrors).toEqual([]);
  await holder.context.close();
  await waiter.context.close();
});
