import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

// Task 4.1: an owner adds a simulator account from the panel (test mode, born paused), sees its webhook address once,
// tests it, activates, pauses, retires and archives it. The API decides; the page only shows and asks.
interface Staff {
  email: string;
  password: string;
  secret: string;
}
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_30 ?? '{}') as Staff;
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

/** Pausing or retiring the last card account asks for a confirmation; other suites may have left one active. */
async function confirmIfAsked(page: Page) {
  const proceed = page.getByRole('button', { name: 'Go ahead anyway' });
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
}

test('admin_creates_pauses_retires_and_archives_a_gateway_account', async ({ page }) => {
  await signIn(page, owner());
  await page.getByRole('link', { name: 'Payment gateways' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Payment gateways' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Available gateways' })).toBeVisible();

  const name = `E2E simulator ${Date.now().toString(36)}`;
  await page.getByLabel('Gateway').selectOption('simulator');
  await page.getByLabel('Account name').fill(name);
  await page.getByRole('button', { name: 'Add account' }).click();
  const url = page.getByTestId('webhook-url');
  await expect(url).toContainText(/\/payments\/webhooks\/[A-Za-z0-9_-]{43}/);
  const address = (await url.textContent()) ?? '';
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('Paused');
  await expect(row).toContainText('Passed');

  // Shown once: gone after a reload.
  await page.reload();
  await expect(page.getByTestId('webhook-url')).toHaveCount(0);
  await expect(page.getByText(address, { exact: false })).toHaveCount(0);

  await row.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name}: Passed` })).toBeVisible();
  await row.getByRole('button', { name: 'Activate' }).click();
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: 'Pause' }).click();
  await confirmIfAsked(page);
  await expect(row).toContainText('Paused');
  await row.getByRole('button', { name: 'Retire' }).click();
  await confirmIfAsked(page);
  await expect(row).toContainText('Retired');
  await row.getByRole('button', { name: 'Archive' }).click();
  await expect(row).toContainText('Archived');
  await expect(row.getByRole('button', { name: 'Archive' })).toHaveCount(0);
});
