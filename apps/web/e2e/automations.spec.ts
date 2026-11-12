import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 14 is an owner (see global-setup.ts).
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_14 ?? '{}') as Staff;
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

async function setAutomations(page: Page, on: boolean) {
  await page.goto('/admin/flags');
  const state = page.getByTestId('flag-state-module.automations');
  if ((await state.textContent()) !== (on ? 'On' : 'Off')) {
    await page.getByRole('row', { name: /module\.automations/ }).getByRole('button').click();
    await expect(state).toHaveText(on ? 'On' : 'Off');
  }
}

async function tasksTitled(page: Page, title: string): Promise<number> {
  const res = await page.request.get(`/api/admin/tables/Task/rows?q=${encodeURIComponent(title)}`, { headers: { 'X-MT-CSRF': '1' } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { total: number }).total;
}

test.use({ actionTimeout: 15_000 });

// Task 7.4: create a scheduled automation, test it (nothing is created), switch it on in test mode, then off.
test('automation_create_test_enable_disable', async ({ page }) => {
  test.setTimeout(120_000);
  const run = `e2e${Date.now().toString(36)}`;
  const title = `Morning check ${run}`;
  await signIn(page, owner());
  await setAutomations(page, true);

  await page.getByRole('link', { name: 'Automations' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Automations' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(`Daily ${run}`);
  await page.getByLabel('Starts when').selectOption({ label: 'On a schedule' });
  await page.getByLabel('How often').selectOption({ label: 'Every day' });
  await page.getByLabel('Time', { exact: true }).fill('08:00');
  await page.getByLabel('What to do').selectOption({ label: 'Create a task' });
  await page.getByLabel('Task title').fill(title);
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page).toHaveURL(/\/admin\/automations\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('automation-state')).toHaveText('Off');

  // A test changes nothing: it says what would happen and no task appears.
  await page.getByRole('button', { name: 'Run test' }).click();
  const result = page.getByTestId('automation-test-result');
  await expect(result).toContainText('Ran');
  await expect(result).toContainText('Create a task: would be done (test)');
  expect(await tasksTitled(page, title)).toBe(0);
  await expect(page.getByRole('table', { name: /Every time this automation ran/ })).toContainText('Test from this page');

  // Signing in counts as a fresh authenticator check, so switching on asks for no extra code within five minutes.
  await page.getByRole('button', { name: 'Switch on in test mode' }).click();
  await expect(page.getByTestId('automation-state')).toHaveText('On, in test mode');
  await page.getByRole('button', { name: 'Switch off' }).click();
  await expect(page.getByTestId('automation-state')).toHaveText('Off');

  await page.goto('/admin/automations');
  await expect(page.getByRole('row', { name: new RegExp(`Daily ${run}`) })).toContainText('Off');
  expect(await tasksTitled(page, title)).toBe(0);
});
