import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 12 holds every permission; slot 13 can read the register and nothing else (see global-setup.ts).
const manager = (): Staff => JSON.parse(process.env.E2E_STAFF_12 ?? '{}') as Staff;
const reader = (): Staff => JSON.parse(process.env.E2E_STAFF_13 ?? '{}') as Staff;
const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };

async function signIn(page: Page, s: Staff) {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(code(s.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test.use({ actionTimeout: 15_000 });

// Task 7.6: a complaint is logged late, shows as overdue, is acknowledged (late), investigated, resolved with a written
// decision, noted and closed; a reader sees the register but cannot log anything.
test('complaint_logged_overdue_acknowledged_resolved_closed_and_reader_refused', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const run = `e2e${Date.now().toString(36)}`;
  await signIn(page, manager());

  await page.goto('/admin/complaints');
  await expect(page.getByRole('heading', { level: 1, name: 'Complaints' })).toBeVisible();

  // Log a complaint that arrived ten days ago: the two-day acknowledgement deadline has long passed.
  const form = page.getByRole('region', { name: 'Log a complaint' });
  await form.getByLabel('Title', { exact: true }).fill(`${run} late airport transfer`);
  await form.getByLabel('What the complainant said', { exact: true }).fill('The transfer arrived an hour late and we missed the expo.');
  await form.getByLabel('How it reached us', { exact: true }).selectOption({ label: 'Phone' });
  await form.getByLabel('Category', { exact: true }).selectOption({ label: 'Transport' });
  await form.getByLabel('Complainant name', { exact: true }).fill('Pat Complainant');
  await form.getByLabel('Date received', { exact: true }).fill(daysAgo(10));
  await form.getByRole('button', { name: 'Log complaint', exact: true }).click();
  await expect(form.getByText('Complaint logged.')).toBeVisible();

  // Find it in the register: not acknowledged in time.
  await page.getByLabel('Search by reference, name or title', { exact: true }).fill(run);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: `${run} late airport transfer` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Overdue');
  await expect(row).toContainText('Received');
  await row.getByRole('link').click();

  // The record: acknowledge it (late), then investigate.
  await expect(page.getByRole('heading', { level: 1, name: 'Complaint' })).toBeVisible();
  const overview = page.getByRole('region', { name: new RegExp(run) });
  await expect(overview).toContainText('Overdue');
  await page.getByRole('button', { name: 'Mark as acknowledged', exact: true }).click();
  await expect(page.getByText('Complaint updated.')).toBeVisible();
  await expect(overview).toContainText('Acknowledged');
  await expect(overview).toContainText('Done late');
  await page.getByRole('button', { name: 'Start investigating', exact: true }).click();
  await expect(overview).toContainText('Investigating');

  // Resolving needs the written decision.
  await page.getByLabel('Outcome', { exact: true }).selectOption({ label: 'Partly upheld' });
  await page.getByLabel('What was decided and what was offered', { exact: true }).fill('We apologised and arranged a different transfer company for next year.');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  const decision = page.getByRole('region', { name: 'Resolution' });
  await expect(decision).toContainText('Partly upheld');
  await expect(decision).toContainText('We apologised and arranged a different transfer company for next year.');

  // A note for the team, then close it: from then on it cannot be edited.
  await page.getByLabel('Add a note', { exact: true }).fill('Phoned the transfer company; they accepted the delay was theirs.');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(page.getByText('Note added.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('This complaint is closed, so it can no longer be edited.')).toBeVisible();
  const history = page.getByRole('region', { name: 'History' });
  await expect(history).toContainText('Logged');
  await expect(history).toContainText('Status changed');

  // A reader sees the register and the record, and the API refuses their attempt to log one.
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3000' });
  try {
    const other = await ctx.newPage();
    await signIn(other, reader());
    await other.goto('/admin/complaints');
    await expect(other.getByRole('heading', { level: 1, name: 'Complaints' })).toBeVisible();
    const f2 = other.getByRole('region', { name: 'Log a complaint' });
    await f2.getByLabel('Title', { exact: true }).fill(`${run} not allowed`);
    await f2.getByLabel('What the complainant said', { exact: true }).fill('Should be refused.');
    await f2.getByLabel('Complainant name', { exact: true }).fill('Nobody');
    await f2.getByRole('button', { name: 'Log complaint', exact: true }).click();
    await expect(f2.getByText('You do not have permission to do this.')).toBeVisible();
    const list = await other.request.get(`/api/admin/complaints?q=${run}&status=closed`, { headers: STATE });
    expect(list.status()).toBe(200);
    const items = ((await list.json()).items ?? []) as Array<{ summary: string }>;
    expect(items.map((i) => i.summary)).toEqual([`${run} late airport transfer`]);
    const denied = await other.request.post('/api/admin/complaints', { headers: STATE, data: { channel: 'email', category: 'other', summary: 'x', description: 'x', complainantName: 'x' } });
    expect(denied.status()).toBe(403);
  } finally {
    await ctx.close();
  }
});
