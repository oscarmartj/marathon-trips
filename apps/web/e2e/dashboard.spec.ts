import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 22 is an owner (see global-setup.ts).
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_22 ?? '{}') as Staff;
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

// Task 5.6: the panel's home page lists what needs attention. An overdue task shows up with its warning in words.
test('dashboard_shows_sections_and_an_overdue_task', async ({ page }) => {
  test.setTimeout(120_000);
  const run = `e2e${Date.now().toString(36)}`;
  await signIn(page, owner());
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const task = await page.request.post('/api/admin/tasks', { headers: { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' }, data: { title: `Chase the hotel ${run}`, dueAt: yesterday } });
  expect(task.status()).toBe(201);

  await page.reload();
  const board = page.getByTestId('dashboard');
  await expect(board).toBeVisible();
  // An owner sees all five sections, each under its own heading.
  for (const name of ['New booking requests', 'Payments to collect', 'Tasks due', 'Places left', 'Alert subscribers by race']) {
    await expect(board.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  const tasks = board.getByRole('region', { name: 'Tasks due' });
  const row = tasks.getByRole('row', { name: new RegExp(`Chase the hotel ${run}`) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Overdue')).toBeVisible();
  await expect(tasks.getByRole('link', { name: 'Open all tasks' })).toHaveAttribute('href', '/admin/tasks');
});

// The API refuses what the page would show to someone without the permission, whatever the page does.
test('dashboard_api_needs_its_permission', async ({ request }) => {
  const res = await request.get('/api/admin/dashboard');
  expect(res.status()).toBe(401);
});
