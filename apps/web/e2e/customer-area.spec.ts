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
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_18 ?? '{}') as Staff;
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

// Task 5.1, the customer area and payment links against the payment simulator: a customer sees her booking in her
// account, pays the deposit from it, downloads the documents the booking now has, and the balance is paid through a
// single-use payment link opened in a browser with no session. The spent link stops working; another customer sees
// nothing of the booking. Nothing real is charged and no amount is ever typed or sent from the browser.
test('customer_area_and_payment_link', async ({ page, browser }) => {
  test.setTimeout(480_000);
  const run = Date.now().toString(36);
  const raceName = `Rottnest Run ${run}`;
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
  const race = (await call('post', '/admin/catalogue/races', { slug: `rottnest-${run}`, name: text(raceName), countryCode: 'AU', city: 'Perth', timeZone: 'Australia/Perth', raceType: 'road', summary: text('A flat, fast marathon.') })).body;
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


  // ---- Customer A requests the trip; the team approves it ----
  const a = await signedInCustomer(browser);
  a.page.on('pageerror', (e) => pageErrors.push(e.message));
  await a.page.goto('/races');
  await a.page.getByLabel('Race or city').fill(raceName);
  await a.page.getByLabel('Race or city').press('Enter');
  await a.page.getByRole('link', { name: raceName }).first().click();
  await a.page.getByRole('link', { name: 'Build this package' }).first().click();
  await expect(a.page.getByRole('heading', { name: 'Your price' })).toBeVisible();
  await a.page.getByRole('link', { name: 'Request this trip' }).click();
  await a.page.getByLabel(/^Given name/).fill('Ada');
  await a.page.getByLabel(/^Family name/).fill('Runner');
  await a.page.getByRole('button', { name: 'Send booking request' }).click();
  const reference = (await a.page.getByText(/^MT-[0-9A-Z]{6}$/).first().textContent())!.trim();

  // In her account before approval: the request, said plainly, and nothing to pay or download.
  await a.page.goto('/account');
  await expect(a.page.getByRole('heading', { level: 2, name: 'Your bookings' })).toBeVisible();
  await a.page.getByRole('link', { name: new RegExp(`${raceName} 2027`) }).click();
  await expect(a.page).toHaveURL(new RegExp(`/account/bookings/${reference}$`));
  await expect(a.page.getByText(/It is a request, not a confirmed booking/)).toBeVisible();
  await expect(a.page.getByRole('link', { name: /^Pay .* now$/ })).toHaveCount(0);
  await expect(a.page.getByText('Your documents appear here once your booking is confirmed.')).toBeVisible();

  await page.goto('/admin/bookings');
  await page.getByLabel('Search bookings').fill(reference);
  await page.locator('#main').getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: /^All$/ }).click();
  await page.getByRole('link', { name: reference }).click();
  await page.getByRole('button', { name: 'Approve request' }).click();
  await expect(page.getByText('Request approved. The customer has been emailed.')).toBeVisible();

  // ---- A pays the deposit from her account, through checkout and the simulator ----
  await a.page.reload();
  await expect(a.page.getByText('Request approved. We are holding your places until the deposit is paid.')).toBeVisible();
  await expect(a.page.getByRole('table', { name: /Payment plan/ })).toBeVisible();
  await a.page.getByRole('link', { name: /^Pay \$[0-9,]+\.[0-9]{2} now$/ }).click();
  await expect(a.page).toHaveURL(new RegExp(`/checkout/${reference}$`));
  await a.page.getByRole('checkbox', { name: /I have read and accept the booking terms/ }).check();
  await a.page.getByRole('button', { name: 'Pay now' }).click();
  await expect(a.page).toHaveURL(/\/api\/payments\/simulator\/checkout\//);
  await a.page.getByRole('button', { name: 'Pay (test)' }).click();
  await a.page.getByRole('link', { name: 'Back to the site' }).click();
  await expect(a.page.getByRole('heading', { level: 2, name: 'Payment received' })).toBeVisible({ timeout: 30_000 });
  await a.page.getByRole('link', { name: 'View your booking' }).click();
  await expect(a.page).toHaveURL(new RegExp(`/account/bookings/${reference}$`));
  await expect(a.page.getByText('Booking confirmed.', { exact: true })).toBeVisible();
  await expect(a.page.getByText(/ on .* \(Brisbane time\), by Credit or debit card$/)).toHaveCount(1);

  // Documents: a confirmation and an itinerary as PDF files; no voucher until paid in full.
  const confirmation = a.page.getByRole('link', { name: 'Booking confirmation (PDF)' });
  await expect(confirmation).toBeVisible();
  await expect(a.page.getByRole('link', { name: 'Itinerary (PDF)' })).toBeVisible();
  await expect(a.page.getByRole('link', { name: 'Voucher (PDF)' })).toHaveCount(0);
  const pdf = await a.context.request.get((await confirmation.getAttribute('href'))!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toBe(`attachment; filename="${reference}-confirmation.pdf"`);
  expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // ---- A adds her traveller details after the deposit (task 5.2); they are still there after a reload ----
  await expect(a.page.getByRole('heading', { level: 2, name: 'Traveller details' })).toBeVisible();
  await expect(a.page.getByText(/^You can change these details until /)).toBeVisible();
  await a.page.getByRole('link', { name: 'Add or change traveller details' }).click();
  await expect(a.page).toHaveURL(new RegExp(`/account/bookings/${reference}/travellers$`));
  await expect(a.page.getByText(/This form has no place to enter them\./)).toBeVisible();
  await expect(a.page.getByLabel(/passport|medical|dietary|allerg/i)).toHaveCount(0);
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
  await expect(a.page.getByLabel('Date of birth').first()).toHaveValue('1985-07-02');
  await expect(a.page.getByLabel('Estimated finish time: minutes').first()).toHaveValue('30');
  await a.page.getByRole('link', { name: 'Back to your booking' }).click();
  await expect(a.page.getByText(/^[0-9]+ of [0-9]+ travellers have the details we need\.$/)).toBeVisible();

  // ---- The team emails a payment link for the balance ----
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Payment links' })).toBeVisible();
  await page.getByRole('button', { name: 'Email a payment link' }).click();
  await expect(page.getByText("Payment link queued for the customer's email.")).toBeVisible();
  await expect(page.getByText(/^Waiting to be emailed: plan item 2/)).toBeVisible();
  // The e2e run reads no mailbox: the token is minted by the same function as the email's send step.
  const { token } = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-payment-link.ts', reference], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' })) as { token: string };

  // ---- The balance is paid through the link, in a browser with no session ----
  const holder = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const pay = await holder.newPage();
  pay.on('pageerror', (e) => pageErrors.push(e.message));
  const linkPage = await pay.goto(`/pay#token=${token}`);
  expect(linkPage!.headers()['referrer-policy']).toBe('no-referrer');
  expect(linkPage!.headers()['x-frame-options']).toBe('DENY');
  await expect(pay.getByText(/^Amount due now: \$[0-9,]+\.[0-9]{2}$/)).toBeVisible();
  // The fragment is cleared from the address bar once read.
  await expect(pay).toHaveURL(/\/pay$/);
  await expect(pay.getByText(reference)).toBeVisible();
  await expect(pay.getByText('Ada')).toHaveCount(0);
  await expect(pay.locator('input[type="text"], input[type="number"], input[type="tel"]')).toHaveCount(0);
  await expect(pay.getByRole('radio', { name: 'Credit or debit card' })).toBeChecked();
  await pay.getByRole('button', { name: 'Pay now' }).click();
  await expect(pay).toHaveURL(/\/api\/payments\/simulator\/checkout\//);
  await pay.getByRole('button', { name: 'Pay (test)' }).click();
  await pay.getByRole('link', { name: 'Back to the site' }).click();
  await expect(pay).toHaveURL(/\/pay\/return$/);
  await expect(pay.getByRole('heading', { level: 2, name: 'Payment received' })).toBeVisible({ timeout: 30_000 });

  // The link has served: the same token is refused, in a fresh browser too.
  const again = await (await browser.newContext({ baseURL: 'http://localhost:3000' })).newPage();
  await again.goto(`/pay#token=${token}`);
  await expect(again.getByText(/This payment link is not valid\./)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/^Used: plan item 2/)).toBeVisible();

  // ---- A sees the booking paid in full, with its voucher ----
  await a.page.reload();
  await expect(a.page.getByText('Booking confirmed and paid in full.')).toBeVisible();
  await expect(a.page.getByRole('link', { name: 'Voucher (PDF)' })).toBeVisible();
  await expect(a.page.getByRole('link', { name: /^Pay .* now$/ })).toHaveCount(0);

  // ---- Customer B sees nothing of A's booking ----
  const b = await signedInCustomer(browser);
  await b.page.goto(`/account/bookings/${reference}`);
  await expect(b.page.getByRole('heading', { level: 1, name: 'Booking' })).toBeVisible();
  await expect(b.page.getByText('We could not show this booking.', { exact: false })).toBeVisible();
  expect((await b.context.request.get(`/api/account/bookings/${reference}/documents/confirmation`)).status()).toBe(404);
  expect((await b.context.request.get(`/api/account/bookings/${reference}`)).status()).toBe(404);
  await expect(b.page.getByText(reference)).toHaveCount(0);
  // ...nor of her traveller details: the same neutral page, and the API answers 404 to read, save and remove.
  await b.page.goto(`/account/bookings/${reference}/travellers`);
  await expect(b.page.getByText('We could not show these details.', { exact: false })).toBeVisible();
  await expect(b.page.getByText('Ada')).toHaveCount(0);
  expect((await b.context.request.get(`/api/account/bookings/${reference}/travellers`)).status()).toBe(404);
  expect((await b.context.request.put(`/api/account/bookings/${reference}/travellers/1`, { headers: STATE, data: { givenName: 'Mallory', familyName: 'Intruder' } })).status()).toBe(404);
  expect((await b.context.request.delete(`/api/account/bookings/${reference}/travellers/1`, { headers: STATE })).status()).toBe(404);
  await b.page.goto('/account');
  await expect(b.page.getByText('You have no bookings yet.', { exact: false })).toBeVisible();

  expect(pageErrors).toEqual([]);
  await Promise.all([a.context.close(), b.context.close(), holder.close(), again.context().close()]);
});
