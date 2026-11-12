import { expect, test, type Locator, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Each spec file signs in with an owner of its own where it can: the API refuses a TOTP code it has already accepted.
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

const formWith = (page: Page, button: string): Locator => page.locator('form', { has: page.getByRole('button', { name: button, exact: true }) });
/** A label with or without the required marker (" *") that the form adds after the text. */
const label = (text: string) => new RegExp(`^${text}(?: \\*)?$`);
const STATE = { 'X-MT-CSRF': '1', Origin: 'http://localhost:3000' };

test.use({ actionTimeout: 15_000 });

// Phase 7 criterion: a custom field appears in forms, filters and exports without touching code.
test('custom_field_appears_in_form_filter_and_export', async ({ page }) => {
  test.setTimeout(150_000);
  const run = `e2e${Date.now().toString(36)}`;
  const colour = `${run} Bib colour`;
  const colourKey = `${run}_bib_colour`;
  await signIn(page, owner());

  try {
    // Define two fields on races from the settings page.
    await page.goto('/admin/settings');
    await page.getByRole('link', { name: 'Custom fields' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Custom fields' })).toBeVisible();
    await page.getByLabel('Kind of record', { exact: true }).selectOption({ label: 'Races' });
    let f = formWith(page, 'Add field');
    await f.getByLabel(label('Label')).fill(colour);
    await f.getByLabel('Type', { exact: true }).selectOption({ label: 'Choose one' });
    await f.getByLabel('Choices', { exact: true }).fill('red | Red\nblue | Blue');
    await f.getByRole('button', { name: 'Add field', exact: true }).click();
    await expect(page.getByText('Field added.')).toBeVisible();
    const table = page.getByRole('table', { name: 'Custom fields, in the order they appear on forms' });
    await expect(table.getByRole('rowheader', { name: colour })).toBeVisible();
    await expect(table.getByRole('cell', { name: colourKey })).toBeVisible();

    f = formWith(page, 'Add field');
    await f.getByLabel(label('Label')).fill(`${run} Start wave`);
    await f.getByLabel('Type', { exact: true }).selectOption({ label: 'Number' });
    await f.getByLabel('Smallest number').fill('1');
    await f.getByRole('button', { name: 'Add field', exact: true }).click();
    await expect(table.getByRole('rowheader', { name: `${run} Start wave` })).toBeVisible();

    // The new field is on the race form straight away, and its value is saved with the race.
    await page.goto('/admin/races');
    f = formWith(page, 'Add race');
    await f.getByLabel(label('Name')).fill(`${run} Red Run`);
    await f.getByLabel('City').fill('Gold Coast');
    await f.getByLabel('Summary').fill('A flat, fast course by the beach.');
    await f.getByLabel(label(colour)).selectOption({ label: 'Red' });
    await f.getByLabel(label(`${run} Start wave`)).fill('3');
    await f.getByRole('button', { name: 'Add race', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/races\/[0-9a-f-]{36}$/);
    const raceUrl = page.url();
    await expect(page.getByLabel(label(colour))).toHaveValue('red');
    await expect(page.getByLabel(label(`${run} Start wave`))).toHaveValue('3');

    // A number the field refuses is stopped with a message, not saved.
    await page.getByLabel(label(`${run} Start wave`)).fill('0');
    await page.locator('form', { has: page.getByLabel(label(colour)) }).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('A custom field value is not valid')).toBeVisible();

    // A second race without the value.
    await page.goto('/admin/races');
    f = formWith(page, 'Add race');
    await f.getByLabel(label('Name')).fill(`${run} Plain Run`);
    await f.getByLabel('City').fill('Cairns');
    await f.getByLabel('Summary').fill('A hot, hilly course.');
    await f.getByRole('button', { name: 'Add race', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/races\/[0-9a-f-]{36}$/);

    // Filter the list by the field.
    await page.goto('/admin/races');
    const search = page.getByRole('search', { name: 'Search races' });
    await search.getByLabel(label('Search')).fill(run);
    await search.getByLabel('Field').selectOption({ label: colour });
    await search.getByLabel('Value').selectOption({ label: 'Red' });
    await search.getByRole('button', { name: 'Search', exact: true }).click();
    const list = page.getByRole('table', { name: 'Races' });
    await expect(list.getByRole('link', { name: `${run} Red Run` })).toBeVisible();
    await expect(list.getByRole('link', { name: `${run} Plain Run` })).toHaveCount(0);

    // Showing a field to customers asks first, says how many records already hold a value, and only then saves.
    await page.goto('/admin/settings/custom-fields');
    await page.getByLabel('Kind of record', { exact: true }).selectOption({ label: 'Races' });
    await table.getByRole('row', { name: new RegExp(`${run} Start wave`) }).getByRole('button', { name: /^Edit/ }).click();
    const edit = formWith(page, 'Save changes');
    await edit.getByLabel('Show to customers on the website').check();
    await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
    const ask = page.getByRole('region', { name: /Show .*Start wave.* to customers\?/ });
    await expect(ask).toBeFocused();
    await expect(edit.getByText('Confirm in the box above the list to make this field visible to customers.')).toBeVisible();
    await expect(ask.getByText('1 record already holds a value for this field.')).toBeVisible();
    await ask.getByRole('button', { name: 'Keep it internal' }).click();
    await expect(ask).toHaveCount(0);
    await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
    await ask.getByRole('button', { name: 'Show to customers' }).click();
    await expect(ask).toHaveCount(0);
    await expect(table.getByRole('row', { name: new RegExp(`${run} Start wave`) })).toContainText('Shown to customers');

    // A required choose-several field says "required" in its group name, not only with a star.
    f = formWith(page, 'Add field');
    await f.getByLabel(label('Label')).fill(`${run} Wave groups`);
    await f.getByLabel('Type', { exact: true }).selectOption({ label: 'Choose several' });
    await f.getByLabel('Choices', { exact: true }).fill('a | Group A\nb | Group B');
    await f.getByLabel('Required when a record is created').check();
    await f.getByRole('button', { name: 'Add field', exact: true }).click();
    await expect(table.getByRole('rowheader', { name: `${run} Wave groups` })).toBeVisible();
    await page.goto(raceUrl);
    await expect(page.getByRole('group', { name: new RegExp(`${run} Wave groups.*required`) })).toBeVisible();

    // The CSV export carries the column and the value.
    const exported = await page.request.post('/api/admin/catalogue/races/export', { headers: STATE, data: {} });
    expect(exported.status()).toBe(200);
    const csv = await exported.text();
    expect(csv.split('\r\n')[0]).toContain(`cf:${colourKey}`);
    expect(csv).toContain(`${run} Red Run`.replace(/,/g, ''));
    expect(raceUrl).toContain('/admin/races/');
  } finally {
    // Fields are archived, never deleted: leave none active for the other specs.
    const defs = await (await page.request.get('/api/admin/custom-fields?entityType=Race', { headers: STATE })).json();
    for (const d of (defs.items ?? []) as Array<{ id: string; key: string; version: number }>) {
      if (d.key.startsWith(run)) await page.request.post(`/api/admin/custom-fields/${d.id}/archive`, { headers: STATE, data: { version: d.version } });
    }
  }
});
