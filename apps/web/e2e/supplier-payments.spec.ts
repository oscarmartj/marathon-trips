import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 31 is an owner (see global-setup.ts).
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_31 ?? '{}') as Staff;
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

async function setSuppliers(page: Page, on: boolean) {
  await page.goto('/admin/flags');
  const state = page.getByTestId('flag-state-module.suppliers');
  if ((await state.textContent()) !== (on ? 'On' : 'Off')) {
    await page.getByRole('row', { name: /module\.suppliers/ }).getByRole('button').click();
    await expect(state).toHaveText(on ? 'On' : 'Off');
  }
}

/** The owner's second factor is made ten minutes old, so the next payment action asks for a fresh code. */
const staleStepUp = (email: string) =>
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-stale-step-up.ts', email], { cwd: join(__dirname, '..', '..', 'api'), env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' });

const brisbaneIn = (n: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date(Date.now() + n * 86_400_000));

test.use({ actionTimeout: 15_000 });

// Task 6.2: a cost due soon shows on the schedule; it is recorded as paid (no money is sent), then voided.
test('supplier_payment_record_and_void', async ({ page }) => {
  test.setTimeout(120_000);
  const run = `e2e${Date.now().toString(36)}`;
  await signIn(page, owner());
  await setSuppliers(page, true);
  const csrf = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };
  const supplier = await page.request.post('/api/admin/suppliers', { headers: csrf, data: { kind: 'hotel', name: `Harbour ${run}`, countryCode: 'DK', defaultCurrency: 'DKK' } });
  expect(supplier.status()).toBe(201);
  const supplierId = ((await supplier.json()) as { id: string }).id;
  const cost = await page.request.post(`/api/admin/suppliers/${supplierId}/costs`, { headers: csrf, data: { description: `Rooms ${run}`, basis: 'fixed', quantity: 1, unitAmountMinor: '50000', currency: 'DKK', dueDate: brisbaneIn(5) } });
  expect(cost.status()).toBe(201);

  await page.goto('/admin/suppliers/payments');
  await expect(page.getByRole('heading', { level: 1, name: 'Supplier payments' })).toBeVisible();
  await expect(page.getByRole('table', { name: /Next 7 days/ }).getByRole('row', { name: new RegExp(`Harbour ${run}`) })).toContainText('500.00');

  await page.goto(`/admin/suppliers/${supplierId}`);
  await expect(page.getByText('Recording a payment sends no money: pay from your bank, then record it here.')).toBeVisible();
  await page.getByLabel(new RegExp(`Rooms ${run}`)).check();
  await page.getByRole('button', { name: 'Check total' }).click();
  await expect(page.getByText(/Total: DKK\s*500\.00/)).toBeVisible();
  await page.getByLabel('Reference', { exact: true }).fill(`INV-${run}`);
  // Recording is a money fact: with a stale second factor the panel asks for a fresh code, then records.
  staleStepUp(owner().email);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('heading', { name: "Confirm it's you" })).toBeVisible();
  await page.getByLabel('Authenticator code').fill(code(owner().secret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await expect(page.getByText(new RegExp(`ref INV-${run}`))).toBeVisible();
  await expect(page.getByText('Nothing owed.')).toBeVisible();

  await page.getByText('Void payment').first().click();
  await page.getByLabel('Reason', { exact: true }).fill('Recorded against the wrong invoice');
  await page.getByRole('button', { name: 'Void payment' }).click();
  await expect(page.getByText('Payment voided.')).toBeVisible();
  await expect(page.getByText('Voided: Recorded against the wrong invoice')).toBeVisible();
  await expect(page.getByLabel(new RegExp(`Rooms ${run}`))).toBeVisible();
});
