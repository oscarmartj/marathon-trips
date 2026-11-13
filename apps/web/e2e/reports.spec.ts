import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 19 is an owner (see global-setup.ts).
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_19 ?? '{}') as Staff;
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

async function setReports(page: Page, on: boolean) {
  await page.goto('/admin/flags');
  const state = page.getByTestId('flag-state-module.reports');
  if ((await state.textContent()) !== (on ? 'On' : 'Off')) {
    await page.getByRole('row', { name: /module\.reports/ }).getByRole('button').click();
    await expect(state).toHaveText(on ? 'On' : 'Off');
  }
}

test.use({ actionTimeout: 15_000 });

// Task 7.7: a visit is counted, shows in the funnel, and a report can be previewed, saved with a schedule, run and deleted.
test('funnel_and_report_builder', async ({ page }) => {
  test.setTimeout(150_000);
  const run = `e2e${Date.now().toString(36)}`;
  const raceName = `Reports race ${run}`;
  const reportName = `Weekly funnel ${run}`;
  await signIn(page, owner());

  // A published race, made through the API as the catalogue e2e does.
  const csrf = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
  const race = await page.request.post('/api/admin/catalogue/races', {
    headers: csrf,
    data: { slug: `rp-${run}`, name: { 'en-AU': raceName }, countryCode: 'AU', city: 'Brisbane', timeZone: 'Australia/Brisbane', raceType: 'road', summary: { 'en-AU': 'A race for the reports test.' } },
  });
  expect(race.status()).toBe(201);
  const { id: raceId, version } = (await race.json()) as { id: string; version: number };
  const published = await page.request.post(`/api/admin/catalogue/races/${raceId}/status`, { headers: csrf, data: { status: 'published', version } });
  expect(published.status()).toBe(200);

  // Two visits and one builder visit, as the race page and the package page send them. Nothing else is sent.
  for (const kind of ['view', 'view', 'builder']) {
    expect((await page.request.post('/api/analytics/race-events', { headers: csrf, data: { raceSlug: `rp-${run}`, kind } })).status()).toBe(204);
  }

  await setReports(page, true);
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();

  // The funnel has the race with its visits.
  const funnelRow = page.getByTestId('funnel-table').getByRole('row', { name: new RegExp(raceName) });
  await expect(funnelRow).toContainText('2');
  await expect(funnelRow.getByRole('cell').nth(0)).toHaveText('2');
  await expect(funnelRow.getByRole('cell').nth(1)).toHaveText('1');
  await expect(page.getByText(/Nothing identifies a visitor/)).toBeVisible();

  // Build a report for this race, preview it, and save it with a weekly email to ourselves.
  await page.getByLabel(/^Name/).fill(reportName);
  await page.getByLabel('Race', { exact: true }).selectOption({ label: raceName });
  await page.getByLabel('Race page visits').check();
  await page.getByLabel('Requests per 100 visits').check();
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByTestId('preview-table');
  await expect(preview.getByRole('row', { name: new RegExp(raceName) })).toContainText('2');
  await expect(preview.getByRole('columnheader', { name: 'Requests per 100 visits' })).toBeVisible();
  await expect(preview).not.toContainText('@');

  await page.getByLabel('Email this report on a schedule').check();
  await page.getByLabel('Day of the week').selectOption({ label: 'Wednesday' });
  await page.getByLabel('Time', { exact: true }).selectOption('08:00');
  await page.getByLabel(owner().email).check();
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByText('Report saved.')).toBeVisible();

  const saved = page.getByRole('row', { name: new RegExp(reportName) });
  await expect(saved).toContainText('Every Wednesday at 08:00; recipients: 1');
  await saved.getByRole('button', { name: `Run ${reportName}` }).click();
  await expect(page.getByTestId('run-table').getByRole('row', { name: new RegExp(raceName) })).toBeVisible();

  // Take the schedule off, then delete the report.
  await saved.getByRole('button', { name: `Edit ${reportName}` }).click();
  await expect(page.getByRole('heading', { level: 2, name: `Edit ${reportName}` })).toBeVisible();
  await page.getByLabel('Email this report on a schedule').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('row', { name: new RegExp(reportName) })).toContainText('Not sent');
  await page.getByRole('row', { name: new RegExp(reportName) }).getByRole('button', { name: `Delete ${reportName}` }).click();
  await expect(page.getByRole('row', { name: new RegExp(reportName) })).toHaveCount(0);
});
