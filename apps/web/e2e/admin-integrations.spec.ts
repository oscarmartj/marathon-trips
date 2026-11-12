import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_6 ?? '{}') as Staff;
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

async function setIntegrations(page: Page, on: boolean) {
  await page.goto('/admin/flags');
  const state = page.getByTestId('flag-state-module.integrations');
  if ((await state.textContent()) !== (on ? 'On' : 'Off')) {
    await page.getByRole('row', { name: /module\.integrations/ }).getByRole('button').click();
    await expect(state).toHaveText(on ? 'On' : 'Off');
  }
}

test('admin_creates_api_key_sees_secret_once_and_revokes', async ({ page }) => {
  await signIn(page, owner());
  await setIntegrations(page, true);
  try {
    await page.getByRole('link', { name: 'Integrations' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
    // Signing in counts as a fresh authenticator check, so no extra code is asked for within five minutes.
    await page.getByLabel('Name', { exact: true }).fill('E2E key');
    await page.getByLabel(/catalogue\.race\.read/).check();
    await page.getByRole('button', { name: 'Create key' }).click();
    const secret = page.getByTestId('one-time-secret');
    await expect(secret).toContainText(/mtk_[a-z2-7]{12}_/);
    const token = (await secret.textContent()) ?? '';
    const prefix = /mtk_([a-z2-7]{12})_/.exec(token)![1]!;
    const row = page.getByTestId(`api-key-${prefix}`);
    await expect(row).toContainText('Active');
    await expect(row).not.toContainText(token);

    // Shown once: after a reload only the prefix is left.
    await page.reload();
    await expect(page.getByTestId('one-time-secret')).toHaveCount(0);
    await expect(page.getByText(token, { exact: false })).toHaveCount(0);
    await expect(page.getByTestId(`api-key-${prefix}`)).toBeVisible();

    await page.getByTestId(`api-key-${prefix}`).getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByTestId(`api-key-${prefix}`)).toContainText('Revoked');
  } finally {
    await setIntegrations(page, false);
  }
});
