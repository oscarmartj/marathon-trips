import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 24 is an owner (see global-setup.ts).
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_24 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();

async function signIn(page: Page, s: Staff) {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test.use({ actionTimeout: 15_000 });

// Task 7.1: pick a trip, see its three lists, and download one as a CSV attachment that is never cached.
test('trip_lists_pick_view_download', async ({ page }) => {
  test.setTimeout(120_000);
  const run = `e2e${Date.now().toString(36)}`;
  await signIn(page, owner());

  const csrf = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
  const race = await page.request.post('/api/admin/catalogue/races', {
    headers: csrf,
    data: { slug: `tl-${run}`, name: { 'en-AU': `Trip lists race ${run}` }, countryCode: 'AU', city: 'Brisbane', timeZone: 'Australia/Brisbane', raceType: 'road', summary: { 'en-AU': 'A race for the trip lists test.' } },
  });
  expect(race.status()).toBe(201);
  const raceId = ((await race.json()) as { id: string }).id;
  const edition = await page.request.post(`/api/admin/catalogue/races/${raceId}/editions`, { headers: csrf, data: { year: 2031, startDate: '2031-06-20', endDate: '2031-06-20', dateStatus: 'provisional' } });
  expect(edition.status()).toBe(201);
  const editionId = ((await edition.json()) as { id: string }).id;
  const pkg = await page.request.post(`/api/admin/catalogue/editions/${editionId}/packages`, {
    headers: csrf,
    data: { slug: `tl-pkg-${run}`, name: { 'en-AU': 'Race weekend' }, checkInDate: '2031-06-18', checkOutDate: '2031-06-21', balanceDueDate: '2031-04-18', maxTravellers: 4, deposit: { mode: 'per_person', amountMinor: '50000' } },
  });
  expect(pkg.status()).toBe(201);
  const packageId = ((await pkg.json()) as { id: string }).id;

  await page.getByRole('link', { name: 'Trip lists' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trip lists' })).toBeVisible();
  await page.getByLabel('Trip', { exact: true }).selectOption({ label: `Trip lists race ${run} 2031 · Race weekend (0 on the lists)` });

  await expect(page.getByRole('heading', { level: 2, name: 'Rooming list' })).toBeVisible();
  await expect(page.getByText('No rooms to list yet.')).toBeVisible();
  await expect(page.getByText('No transfers have been booked yet.')).toBeVisible();
  await expect(page.getByText('The race dates are provisional.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: /^Day 1, / })).toBeVisible();

  const link = page.getByRole('link', { name: 'Download Rooming list as CSV' });
  await expect(link).toHaveAttribute('href', `/api/admin/trip-ops/trips/${packageId}/rooming-list?format=csv`);
  const csv = await page.request.get(`/api/admin/trip-ops/trips/${packageId}/rooming-list?format=csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['cache-control']).toBe('no-store');
  expect(csv.headers()['content-disposition']).toMatch(/^attachment; filename="rooming-list-[a-z0-9-]+\.csv"$/);
});
