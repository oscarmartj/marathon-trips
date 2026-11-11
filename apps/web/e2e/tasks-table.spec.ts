import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
const owner = (): Staff => JSON.parse(process.env.E2E_STAFF_3 ?? '{}') as Staff;
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

// Phase 0 criterion: the example table uses every shared capability.
test('tasks_table_uses_every_shared_capability', async ({ page }) => {
  test.setTimeout(120_000);
  const run = `e2e${Date.now().toString(36)}`;
  await signIn(page, owner());
  // A tag to apply later (tag management has no page yet).
  const tag = await page.request.post('/api/admin/tags', { headers: { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' }, data: { name: `${run}-urgent`, colour: '#b45309' } });
  expect(tag.status()).toBe(201);

  await page.goto('/admin/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();

  // Create three tasks.
  await page.getByText('New task', { exact: true }).click();
  for (const name of ['alpha', 'bravo', 'charlie']) {
    const title = page.getByLabel('Title', { exact: true }).first();
    await title.fill(`${run} ${name}`);
    await page.getByRole('button', { name: 'Create task' }).click();
    await expect(title).toHaveValue(''); // the form clears itself once the task is saved
  }

  // Search.
  await page.getByLabel('Search this table').fill(run);
  await page.getByRole('main').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Showing 1 to 3 of 3' })).toBeVisible();
  await page.getByLabel('Search this table').fill(`${run} bravo`);
  await page.getByRole('main').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'of 1' })).toBeVisible();
  await page.getByLabel('Search this table').fill(run);
  await page.getByRole('main').getByRole('button', { name: 'Search', exact: true }).click();

  // Filter, then save the view, clear the filter and apply the view again.
  await page.getByText('Filters', { exact: true }).first().click();
  await page.getByLabel('Field', { exact: true }).selectOption({ label: 'Title' });
  await page.getByLabel('Condition', { exact: true }).selectOption({ label: 'contains' });
  await page.getByLabel('Value', { exact: true }).fill('alpha');
  await page.getByRole('button', { name: 'Add filter' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'of 1' })).toBeVisible();
  await page.getByText('Saved views', { exact: true }).first().click();
  await page.getByLabel('Name for this view').fill(`${run} alpha only`);
  await page.getByRole('button', { name: 'Save current view' }).click();
  await expect(page.getByText('View saved.')).toBeVisible();
  await page.getByRole('button', { name: /^Remove filter/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'of 3' })).toBeVisible();
  await page.getByLabel('Saved view').selectOption({ label: `${run} alpha only` });
  await page.getByRole('button', { name: 'Apply view' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'of 1' })).toBeVisible();
  await page.getByRole('button', { name: /^Remove filter/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'of 3' })).toBeVisible();

  // Sort by title: the header exposes the order.
  await page.getByRole('button', { name: 'Title', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /Title/ })).toHaveAttribute('aria-sort', 'ascending');

  // Tags, notes and history in the record panel.
  await page.getByRole('button', { name: `Open ${run} alpha` }).click();
  await expect(page.getByRole('heading', { level: 2, name: `${run} alpha` })).toBeFocused();
  await page.getByRole('complementary', { name: `${run} alpha` }).getByRole('checkbox', { name: `${run}-urgent` }).check();
  await page.getByRole('button', { name: 'Save tags' }).click();
  await expect(page.getByText('Tags saved.')).toBeVisible();
  await page.getByLabel('Add a note').fill('Called the hotel');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Note added.')).toBeVisible();
  await expect(page.getByText('Called the hotel')).toBeVisible();
  await page.getByLabel('Status', { exact: true }).last().selectOption({ label: 'Done' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Task saved.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'History' })).toBeVisible();
  await expect(page.locator('ins', { hasText: 'done' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId(/^row-/).filter({ hasText: `${run}-urgent` })).toHaveCount(1);

  // Bulk action on the two open tasks.
  await page.getByRole('checkbox', { name: `Select ${run} bravo` }).check();
  await page.getByRole('checkbox', { name: `Select ${run} charlie` }).check();
  await page.getByLabel('Action', { exact: true }).selectOption({ label: 'Mark as done' });
  await page.getByRole('button', { name: 'Apply to selected' }).click();
  await expect(page.getByText('2 of 2 records updated.')).toBeVisible();

  // CSV export downloads a file; import checks the file before writing anything.
  await page.getByText('CSV', { exact: true }).first().click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^task-\d{4}-\d{2}-\d{2}\.csv$/);
  await page.getByLabel('CSV file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(`title,dueAt\r\n${run} imported,not-a-date\r\n`) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('Row 1, column dueAt: the date is not valid')).toBeVisible();
  await expect(page.getByText('The file has problems. Nothing was imported.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import records' })).toBeDisabled();
  await page.getByLabel('CSV file').setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(`title,dueAt\r\n${run} imported,2026-12-01\r\n`) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('The file is valid: 1 rows ready to import.')).toBeVisible();
  await page.getByRole('button', { name: 'Import records' }).click();
  await expect(page.getByText('Imported 1 records.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'of 4' })).toBeVisible();

  // Delete from the record panel, find it among deleted records, restore it.
  await page.getByRole('button', { name: `Open ${run} imported` }).click();
  await page.getByRole('button', { name: 'Delete record' }).click();
  await expect(page.getByText('This record is deleted. Restore it to change it.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'of 3' })).toBeVisible();
  await page.getByLabel('Show', { exact: true }).selectOption({ label: 'Deleted records only' });
  await expect(page.getByRole('status').filter({ hasText: 'of 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByLabel('Show', { exact: true }).selectOption({ label: 'Active records' });
  await expect(page.getByRole('status').filter({ hasText: 'of 4' })).toBeVisible();

  // Global search in the sidebar reaches the same record.
  await page.getByLabel('Search all records').fill(`${run} impo`);
  await page.getByRole('complementary').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('link', { name: `${run} imported` })).toBeVisible();
});
