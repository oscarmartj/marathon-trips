import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 16 is an owner (see global-setup.ts).
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_16 ?? '{}') as Staff;
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

async function setKeyDates(page: Page, on: boolean) {
  await page.goto('/admin/flags');
  const state = page.getByTestId('flag-state-module.keydates');
  if ((await state.textContent()) !== (on ? 'On' : 'Off')) {
    await page.getByRole('row', { name: /module\.keydates/ }).getByRole('button').click();
    await expect(state).toHaveText(on ? 'On' : 'Off');
  }
}

const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.use({ actionTimeout: 15_000 });

// Task 7.3: add a custom key date to an edition, see it on the calendar, move it, then delete it.
test('key_date_add_change_delete', async ({ page }) => {
  test.setTimeout(120_000);
  const run = `e2e${Date.now().toString(36)}`;
  const name = `Bib numbers ${run}`;
  await signIn(page, owner());

  // The calendar needs an edition: make a race with one through the API, as the catalogue e2e does.
  const csrf = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
  const race = await page.request.post('/api/admin/catalogue/races', {
    headers: csrf,
    data: { slug: `kd-${run}`, name: { 'en-AU': `Key date race ${run}` }, countryCode: 'AU', city: 'Brisbane', timeZone: 'Australia/Brisbane', raceType: 'road', summary: { 'en-AU': 'A race for the key dates test.' } },
  });
  expect(race.status()).toBe(201);
  const raceId = ((await race.json()) as { id: string }).id;
  expect((await page.request.post(`/api/admin/catalogue/races/${raceId}/editions`, { headers: csrf, data: { year: 2031 } })).status()).toBe(201);

  await setKeyDates(page, true);
  await page.getByRole('link', { name: 'Key dates' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Key dates' })).toBeVisible();

  await page.getByLabel('Race edition').selectOption({ label: `Key date race ${run} 2031` });
  await page.getByLabel('Kind of date').selectOption({ label: 'Custom date' });
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel(/^Date/).fill(inDays(5));
  await page.getByRole('button', { name: 'Add key date' }).click();
  await expect(page.getByText('Key date added.')).toBeVisible();

  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('Custom date');
  await expect(row).toContainText('Coming up');

  // Move it to a date in the past: it is then shown as overdue.
  await row.getByLabel(/New date for/).fill(inDays(-3));
  await row.getByRole('button', { name: 'Save date' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Overdue');

  await page.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
});
