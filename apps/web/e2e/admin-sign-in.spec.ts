import { expect, test } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
const staff = (name: 'E2E_STAFF' | 'E2E_STAFF_2'): Staff => JSON.parse(process.env[name] ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();

test('admin_signs_in_with_password_and_totp', async ({ page }) => {
  const s = staff('E2E_STAFF');
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  // A change made by the admin, recorded by the API (the audit itself is checked by the API tests).
  await page.getByRole('link', { name: 'Feature flags' }).click();
  const state = page.getByTestId('flag-state-auth.customer_sign_in');
  const before = await state.textContent();
  await page.getByRole('row', { name: /auth\.customer_sign_in/ }).getByRole('button').click();
  await expect(state).not.toHaveText(before ?? '');
  await page.getByRole('row', { name: /auth\.customer_sign_in/ }).getByRole('button').click();
  await expect(state).toHaveText(before ?? '');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test('admin_wrong_totp_rejected', async ({ page }) => {
  const s = staff('E2E_STAFF_2');
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  const right = code(s.secret);
  await page.getByLabel('Authenticator code').fill(right === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText('That code is not right.');
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
});

test('admin_wrong_password_rejected', async ({ page }) => {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill('nobody@example.test');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText('The email or password is not right.');
});
