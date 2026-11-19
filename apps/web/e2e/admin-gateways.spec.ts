import { expect, test, type Locator, type Page } from '@playwright/test';
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

/**
 * Pausing or retiring the last card account asks for a confirmation; other suites may have left one active. Waits for
 * either the new status or the question, answers it if asked, then for the status.
 */
async function settle(page: Page, row: Locator, status: string) {
  const proceed = page.getByRole('button', { name: 'Go ahead anyway' });
  await expect(row.getByRole('cell', { name: status, exact: true }).or(proceed)).toBeVisible();
  if (await proceed.isVisible()) await proceed.click();
  await expect(row.getByRole('cell', { name: status, exact: true })).toBeVisible();
}

test('admin_creates_pauses_retires_and_archives_a_gateway_account', async ({ page }) => {
  await signIn(page, owner());
  await page.getByRole('link', { name: 'Payment gateways' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Payment gateways' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Available gateways' })).toBeVisible();

  const name = `E2E simulator ${Date.now().toString(36)}`;
  await page.getByLabel('Gateway', { exact: true }).selectOption('simulator');
  await page.getByLabel('Account name').fill(name);
  await page.getByRole('button', { name: 'Add account' }).click();
  const url = page.getByTestId('webhook-url');
  await expect(url).toContainText(/\/payments\/webhooks\/[A-Za-z0-9_-]{43}/);
  const address = (await url.textContent()) ?? '';
  // The accounts table only: since 4.2 the routing rules table also names the account.
  const row = page.locator('[data-testid^="account-"]').filter({ hasText: name });
  await expect(row.getByRole('cell', { name: 'Paused', exact: true })).toBeVisible();
  await expect(row).toContainText('Passed');

  // Task 4.2: the new account comes with its default routing rules (card, Apple Pay, Google Pay; never buy now, pay later).
  await expect(page.getByRole('heading', { name: 'Routing rules' })).toBeVisible();
  const rules = page.locator('[data-testid^="rule-"]').filter({ hasText: name });
  await expect(rules).toHaveCount(3);
  await expect(rules.filter({ hasText: 'Buy now, pay later' })).toHaveCount(0);

  // Add a rule and ask who would take a payment: the paused account is listed with its reason.
  await page.getByLabel('Account', { exact: true }).selectOption({ label: name });
  await page.getByLabel('Maximum amount (A$, optional)', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Routing rule saved.' })).toBeVisible();
  await expect(rules).toHaveCount(4);
  await expect(rules.filter({ hasText: 'A$100.00' })).toHaveCount(1);
  await page.getByLabel('Amount (A$, optional)', { exact: true }).fill('50');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: `Card · ${name}: account is not active` }).first()).toBeVisible();

  // Shown once: gone after a reload.
  await page.reload();
  await expect(page.getByTestId('webhook-url')).toHaveCount(0);
  await expect(page.getByText(address, { exact: false })).toHaveCount(0);

  await row.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name}: Passed` })).toBeVisible();
  await row.getByRole('button', { name: 'Activate' }).click();
  await settle(page, row, 'Active');
  await row.getByRole('button', { name: 'Pause' }).click();
  await settle(page, row, 'Paused');
  await row.getByRole('button', { name: 'Retire' }).click();
  await settle(page, row, 'Retired');
  await row.getByRole('button', { name: 'Archive' }).click();
  await settle(page, row, 'Archived');
  await expect(row.getByRole('button', { name: 'Archive' })).toHaveCount(0);
});
