import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Each spec file signs in with its own owner: the API refuses a TOTP code it has already accepted.
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_7 ?? '{}') as Staff;
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

const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
const label = (text: string) => new RegExp(`^${text}(?: \\*)?$`);

// The pricing panel (task 2.2b): create a price version for the demo package, set its rates, see what is missing, preview
// the total with the API's engine, publish it by the panel, then add, preview and change a promo code. Money in the test
// is typed in dollars; the totals are checked against the API's own answer as well as the screen.
test('create_version_set_rates_preview_publish_and_manage_a_promo_code', async ({ page }) => {
  test.setTimeout(240_000);
  const apiDir = join(__dirname, '..', '..', 'api');
  const { packageId } = JSON.parse(
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-package.ts'], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' }),
  ) as { packageId: string };
  const run = Date.now().toString(36);
  const versionName = `Launch prices ${run}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await signIn(page, owner());

  // The package offers one extra night before, so the rates need a price for it too.
  const pkg = await (await page.request.get(`/api/admin/catalogue/packages/${packageId}`)).json();
  const patched = await page.request.patch(`/api/admin/catalogue/packages/${packageId}`, { headers: STATE, data: { maxExtraNightsBefore: 1, version: pkg.version } });
  expect(patched.status()).toBe(200);

  // From the package to its prices.
  await page.goto(`/admin/packages/${packageId}`);
  await page.getByRole('link', { name: 'Prices', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Prices' })).toBeVisible();

  // A draft. Nothing is in force yet.
  await page.getByLabel(label('Name')).fill(versionName);
  await page.getByRole('button', { name: 'Add draft' }).click();
  await expect(page).toHaveURL(/\/admin\/packages\/[0-9a-f-]{36}\/prices\/[0-9a-f-]{36}$/);
  const versionUrl = page.url();
  const versionId = versionUrl.split('/').pop()!;
  await expect(page.getByRole('heading', { level: 2, name: versionName })).toBeVisible();
  // An empty draft lacks everything, and publishing is blocked with the reason.
  await expect(page.getByText(/prices are missing from the saved version/)).toBeVisible();
  await expect(page.getByText('Set every missing price before publishing.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish prices now' })).toBeDisabled();

  // Text that is not an amount is refused on screen and nothing is sent.
  const price = (what: string) => page.getByLabel(`Price per person: ${what}`, { exact: true });
  const night = (what: string) => page.getByLabel(`Extra night per person: ${what}`, { exact: true });
  await price('Single room, 1 in the room').fill('12.345');
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Use at most two decimal places.')).toBeVisible();
  await price('Single room, 1 in the room').fill('abc');
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Enter an amount in dollars, such as 250 or 249.50.')).toBeVisible();

  // Some rates first: the editor saves them and the list of what is missing shrinks.
  await price('Single room, 1 in the room').fill('250');
  await night('Single room, 1 in the room').fill('90');
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Prices saved.')).toBeVisible();
  await expect(page.getByRole('list').filter({ hasText: 'Double room' }).getByText(/Double room: price per person for 1 in the room/)).toBeVisible();

  // The rest.
  await price('Double room, 1 in the room').fill('$1,234.50');
  await night('Double room, 1 in the room').fill('90');
  await price('Double room, 2 in the room').fill('180');
  await night('Double room, 2 in the room').fill('90');
  await price('Family room, 3 in the room').fill('150');
  await night('Family room, 3 in the room').fill('90');
  await price('Family room, 4 in the room').fill('140');
  await night('Family room, 4 in the room').fill('90');
  for (const distance of ['Marathon', 'Half marathon', '10 km']) await page.getByLabel(`Price: Runner with entry included: ${distance}`, { exact: true }).fill('100');
  await page.getByLabel('Price: Supporter', { exact: true }).fill('0');
  await page.getByLabel('Price: Demo pasta party', { exact: true }).fill('45');
  await page.getByLabel('Price: Demo airport transfer', { exact: true }).fill('60');
  // Unsaved changes block publishing.
  await expect(page.getByText('You have unsaved changes.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish prices now' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Every price is set. This version can be published.')).toBeVisible();
  // What was typed as dollars is stored as cents, and read back as dollars.
  await expect(price('Double room, 1 in the room')).toHaveValue('1234.50');
  const saved = await (await page.request.get(`/api/admin/pricing/price-versions/${versionId}`)).json();
  expect(saved.missing).toEqual([]);
  expect(saved.rates.roomRates.find((r: { occupancy: number; pricePerPersonMinor: string }) => r.pricePerPersonMinor === '123450')).toBeTruthy();

  // Preview the draft: one runner with an entry (Marathon) in the single room. The engine's total is shown as it came.
  await page.getByRole('button', { name: 'Price this trip' }).click();
  await expect(page.getByTestId('preview-total')).toHaveText('A$350.00');
  await expect(page.getByRole('table', { name: 'How the total is made up' }).getByText('Room: Single room')).toBeVisible();
  const quote = await (await page.request.post('/api/admin/pricing/quotes', {
    headers: STATE,
    data: { packageId, priceVersionId: versionId, rooms: [{ roomOptionId: saved.rates.roomRates[0].roomOptionId, travellers: [{ participationType: 'supporter' }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [] },
  })).json();
  expect(quote.totalMinor).toBe(quote.lines.filter((l: { kind: string }) => l.kind === 'room').reduce((_a: string, l: { amountMinor: string }) => l.amountMinor, '0'));

  // Publish now. The owner has just signed in, so the step-up is fresh and the API accepts it.
  await page.getByRole('button', { name: 'Publish prices now' }).click();
  await expect(page.getByText('Published. These prices are in force now.')).toBeVisible();
  await expect(page.getByText(/In force now\. Its prices are frozen\./)).toBeVisible();
  const listed = await (await page.request.get(`/api/admin/pricing/packages/${packageId}/price-versions`)).json();
  expect(listed.currentId).toBe(versionId);
  // A published version cannot be edited from the panel: its prices are text, not boxes.
  await expect(page.getByRole('button', { name: 'Save prices' })).toHaveCount(0);
  await page.goto(`/admin/packages/${packageId}/prices`);
  await expect(page.getByRole('table', { name: 'Price versions' }).getByRole('row', { name: new RegExp(`${versionName} In force now`) })).toBeVisible();

  // A promo code for this package: add, price with it, change it, switch it off.
  const promo = `E2E${run.toUpperCase()}`.slice(0, 12);
  await page.goto(`/admin/pricing?packageId=${packageId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pricing rules and promo codes' })).toBeVisible();
  const form = page.getByRole('form', { name: 'Add a promo code' });
  await form.getByLabel(label('Name')).fill('Launch offer');
  await form.getByLabel(label('Code')).fill(promo.toLowerCase());
  await form.getByLabel(label('Percentage')).fill('10');
  await form.getByLabel('Most times the code can be used').fill('5');
  await form.getByRole('button', { name: 'Add promo code' }).click();
  await expect(form.getByText('Added.')).toBeVisible();
  const codesTable = page.getByRole('table', { name: 'Promo codes' });
  await expect(codesTable.getByRole('row', { name: new RegExp(`${promo}.*10% off the subtotal.*0 of 5.*On`) })).toBeVisible();

  // The preview applies it: 10% off the A$350.00 trip.
  await page.goto(versionUrl);
  await page.getByLabel('Promo code', { exact: true }).fill(promo);
  await page.getByRole('button', { name: 'Price this trip' }).click();
  await expect(page.getByTestId('preview-total')).toHaveText('A$315.00');
  await expect(page.getByText('Applied', { exact: true })).toBeVisible();

  // Change only the percentage; the API gets a PATCH with that field and the version, nothing else.
  await page.goto(`/admin/pricing?packageId=${packageId}`);
  const patches: unknown[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && req.url().includes('/promo-codes/')) patches.push(req.postDataJSON());
  });
  await page.getByRole('button', { name: `Change ${promo}` }).click();
  const edit = page.getByRole('form', { name: 'Change a promo code' });
  await edit.getByLabel(label('Percentage')).fill('15');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit.getByText('Saved.')).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(Object.keys(patches[0] as object).sort()).toEqual(['valueBps', 'version']);
  await expect(codesTable.getByRole('row', { name: new RegExp(`${promo}.*15% off`) })).toBeVisible();
  // Saving with nothing changed sends nothing.
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Nothing has changed, so nothing was saved.')).toBeVisible();
  expect(patches).toHaveLength(1);

  // Switch it off.
  await page.getByRole('button', { name: `Switch off ${promo}` }).click();
  await expect(page.getByText('Switched off.')).toBeVisible();
  await expect(codesTable.getByRole('row', { name: new RegExp(`${promo}.*Off`) })).toBeVisible();
  await page.goto(versionUrl);
  await page.getByLabel('Promo code', { exact: true }).fill(promo);
  await page.getByRole('button', { name: 'Price this trip' }).click();
  await expect(page.getByTestId('preview-total')).toHaveText('A$350.00');
  await expect(page.getByText('Not applied: unknown, switched off, expired or used up')).toBeVisible();
  // Schedule a copy of the prices in force for two days from now, see it in the list, then withdraw it.
  const scheduledName = `Scheduled prices ${run}`;
  await page.goto(`/admin/packages/${packageId}/prices`);
  await page.getByLabel(label('Name')).fill(scheduledName);
  await page.getByRole('checkbox', { name: /^Start from the prices now in force/ }).check();
  await page.getByRole('button', { name: 'Add draft' }).click();
  await expect(page).toHaveURL(/\/prices\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Every price is set. This version can be published.')).toBeVisible();
  const later = new Date(Date.now() + 2 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const startText = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
  await page.getByLabel('Start at a set time').check();
  // A start in the past is refused on screen before anything is sent.
  await page.getByLabel(/^Start time/).fill('2020-01-01T09:00');
  await page.getByRole('button', { name: 'Schedule prices' }).click();
  await expect(page.getByText('The start time must be in the future.').first()).toBeVisible();
  await page.getByLabel(/^Start time/).fill(startText);
  await page.getByRole('button', { name: 'Schedule prices' }).click();
  await expect(page.getByText(/^Scheduled\. These prices start /)).toBeVisible();
  await page.goto(`/admin/packages/${packageId}/prices`);
  const versions = page.getByRole('table', { name: 'Price versions' });
  await expect(versions.getByRole('row', { name: new RegExp(`${scheduledName} Scheduled`) })).toBeVisible();
  await expect(versions.getByRole('row', { name: new RegExp(`${versionName} In force now`) })).toBeVisible();
  await page.getByRole('button', { name: `Withdraw ${scheduledName}` }).click();
  await expect(page.getByText('The scheduled version was withdrawn.')).toBeVisible();
  await expect(versions.getByRole('row', { name: new RegExp(`${scheduledName} Discarded or withdrawn`) })).toBeVisible();

  // No script error on any of the screens visited.
  expect(pageErrors).toEqual([]);
});
