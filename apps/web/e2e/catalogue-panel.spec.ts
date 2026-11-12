import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Each spec file signs in with its own owner: the API refuses a TOTP code it has already accepted, so two sign-ins
// of one account inside 30 seconds would fail.
const owner = (name: 'E2E_STAFF_4' | 'E2E_STAFF_5'): Staff => JSON.parse(process.env[name] ?? '{}') as Staff;
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

/** The form that holds a given button, so labels that repeat on a page (such as "Name") are found in the right form. */
const formWith = (page: Page, button: string): Locator => page.locator('form', { has: page.getByRole('button', { name: button, exact: true }) });
const searchRaces = async (page: Page, text: string) => {
  const search = page.getByRole('search', { name: 'Search races' });
  await search.getByLabel('Search', { exact: true }).fill(text);
  await search.getByRole('button', { name: 'Search', exact: true }).click();
};
const publicRace = (page: Page, slug: string) => page.request.get(`/api/catalogue/races/${slug}`);

// Phase 1 criterion: create a race with an edition, package, hotel and extra in the panel, publish it and see it on the website.
// The public pages are task 1.3, so "see it" is checked on the public catalogue API that those pages read.
test('create_publish_and_view_race', async ({ page }) => {
  test.setTimeout(240_000);
  const run = `e2e${Date.now().toString(36)}`;
  const raceName = `${run} Coast Marathon`;
  const slug = `${run}-coast-marathon`;
  await signIn(page, owner('E2E_STAFF_4'));

  // A hotel.
  await page.goto('/admin/hotels');
  await expect(page.getByRole('heading', { level: 1, name: 'Hotels' })).toBeVisible();
  let f = formWith(page, 'Add hotel');
  await f.getByLabel('Name', { exact: true }).fill(`${run} Riverside Hotel`);
  await f.getByLabel('Address').fill('1 River Street');
  await f.getByLabel('City').fill('Brisbane');
  await f.getByRole('button', { name: 'Add hotel', exact: true }).click();
  await expect(page.getByText('Hotel added.')).toBeVisible();

  // A race, its distance and an edition.
  await page.goto('/admin/races');
  await expect(page.getByRole('heading', { level: 1, name: 'Races' })).toBeVisible();
  f = formWith(page, 'Add race');
  await f.getByLabel('Name', { exact: true }).fill(raceName);
  await f.getByLabel('City').fill('Gold Coast');
  await f.getByLabel('Summary').fill('A flat, fast course by the beach.');
  await f.getByRole('button', { name: 'Add race', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/races\/[0-9a-f-]{36}$/);
  const raceUrl = page.url();
  await expect(page.getByRole('heading', { level: 2, name: raceName })).toBeVisible();

  f = formWith(page, 'Add distance');
  await f.getByLabel('Name', { exact: true }).fill('Marathon');
  await f.getByRole('button', { name: 'Add distance', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Distances' }).getByRole('cell', { name: '42.195 km' })).toBeVisible();

  f = formWith(page, 'Add edition');
  await f.getByLabel('Year').fill('2027');
  await f.getByLabel('Start date').fill('2027-07-04');
  await f.getByLabel('End date').fill('2027-07-04');
  await f.getByRole('button', { name: 'Add edition', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/editions\/[0-9a-f-]{36}$/);
  const editionUrl = page.url();
  // The date is not confirmed, and the panel says so in plain sight.
  await expect(page.getByRole('note').filter({ hasText: 'The dates for this edition are not confirmed' })).toBeVisible();

  // Stock: entries, rooms and extras, plus a pool that is nearly gone to trigger the low-stock warning.
  const addPool = async (kind: string, label: string, capacity: string, threshold = '') => {
    const pf = formWith(page, 'Add stock pool');
    await pf.getByLabel('Label').fill(label);
    await pf.getByLabel('Kind').selectOption({ label: kind });
    await pf.getByLabel('Capacity').fill(capacity);
    await pf.getByLabel('Low-stock level').fill(threshold);
    await pf.getByRole('button', { name: 'Add stock pool', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Stock pools' }).getByRole('rowheader', { name: label })).toBeVisible();
  };
  await addPool('Entries', 'Entry stock', '10', '2');
  await addPool('Rooms', 'Room stock', '10');
  await addPool('Extras', 'Extra stock', '10');
  await expect(page.getByRole('status').filter({ hasText: 'Low stock' })).toHaveCount(0);
  await addPool('Entries', 'Nearly full entries', '2', '2');
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Low stock: 1 to check' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '2 of 2 left' })).toBeVisible();

  // A package.
  f = formWith(page, 'Add package');
  await f.getByLabel('Name', { exact: true }).fill('Race weekend');
  await f.getByLabel('Web address (slug)').fill('race-weekend');
  await f.getByLabel('Check-in date').fill('2027-07-02');
  await f.getByLabel('Check-out date').fill('2027-07-06');
  await f.getByLabel('Balance due date').fill('2027-05-02');
  await f.getByRole('button', { name: 'Add package', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/packages\/[0-9a-f-]{36}$/);
  const packageUrl = page.url();

  // Opening needs a deposit: the API refuses and the panel says why.
  await page.getByRole('button', { name: 'Open for booking' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Set the deposit before opening this package.' })).toBeVisible();

  // Deposit (typed in dollars, stored as cents by the API), who can book, entry, hotel, room and extra.
  f = page.locator('form', { has: page.getByLabel('Deposit type') });
  await f.getByLabel('Deposit type').selectOption({ label: 'Fixed amount per person' });
  await f.getByLabel('Amount (AUD)').fill('500');
  await f.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Deposit: AUD 500.00 per person.')).toBeVisible();
  await page.getByLabel('Runner with entry included').check();
  await formWith(page, 'Save changes').filter({ has: page.getByLabel('Supporter') }).getByRole('button', { name: 'Save changes' }).click();

  f = formWith(page, 'Add entry option');
  await f.getByLabel('Entry stock').selectOption({ label: 'Entry stock' });
  await f.getByRole('button', { name: 'Add entry option' }).click();
  await expect(page.getByText('Marathon, from Entry stock')).toBeVisible();

  f = formWith(page, 'Add hotel');
  await f.getByLabel('Hotel', { exact: true }).selectOption({ label: `${run} Riverside Hotel (Brisbane)` });
  await f.getByRole('button', { name: 'Add hotel', exact: true }).click();
  await expect(page.getByRole('heading', { level: 3, name: new RegExp(`${run} Riverside Hotel`) })).toBeVisible();
  await page.getByText(/Add a room to/).click();
  f = formWith(page, 'Add room');
  await f.getByLabel('Room name').fill('Double room');
  await f.getByLabel('Room stock').selectOption({ label: 'Room stock' });
  await f.getByRole('button', { name: 'Add room', exact: true }).click();
  await expect(page.getByText(/Double room \(Double\), 1 to 2 people, from Room stock/)).toBeVisible();

  f = formWith(page, 'Add extra');
  await f.getByLabel('Name', { exact: true }).fill('City tour');
  await f.getByLabel('Stock', { exact: true }).selectOption({ label: 'Extra stock' });
  await f.getByRole('button', { name: 'Add extra', exact: true }).click();
  await expect(page.getByText(/City tour \(Excursion, per person, Everyone\)/)).toBeVisible();

  // Preview: staff can see the draft; the public site cannot.
  await page.getByRole('link', { name: 'Preview as a visitor' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Package preview' })).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: 'not visible on the website yet' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Race weekend' })).toBeVisible();
  await expect(page.getByText('Marathon: Available')).toBeVisible();
  await expect(page.getByText('Prices are not shown yet.')).toBeVisible();
  await expect(page.getByText('Guaranteed entry', { exact: true })).toHaveCount(0);
  expect((await publicRace(page, slug)).status()).toBe(404);

  // Publish: race, edition, then package. Only then is it public.
  await page.goto(raceUrl);
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Current status: Published.')).toBeVisible();
  await page.goto(editionUrl);
  await page.getByRole('button', { name: 'Announce' }).click();
  await expect(page.getByText('Current status: Announced.')).toBeVisible();
  await page.goto(packageUrl);
  expect((await publicRace(page, slug)).status()).toBe(200);
  expect((await (await publicRace(page, slug)).json()).editions[0].packages).toEqual([]); // the package is still a draft
  await page.getByRole('button', { name: 'Open for booking' }).click();
  await expect(page.getByText('Current status: Open for booking.')).toBeVisible();
  const body = await (await publicRace(page, slug)).json();
  expect(body).toMatchObject({ slug, editions: [{ year: 2027, dateConfirmed: false, packages: [{ slug: 'race-weekend', saleStatus: 'open', guaranteedEntry: false }] }] });
  expect(JSON.stringify(body)).not.toMatch(/capacity|consumed/);
  const pub = await (await page.request.get(`/api/catalogue/races/${slug}/editions/2027/packages/race-weekend`)).json();
  expect(pub).toMatchObject({ hotels: [{ rooms: [{ availability: 'available' }] }], extras: [{ availability: 'available' }], entries: [{ availability: 'available' }] });
  // And on the website itself (task 1.3): the race page lists the open package and flags the unconfirmed date.
  await page.goto(`/races/${slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(raceName);
  await expect(page.getByRole('heading', { level: 3, name: '2027 edition' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 4, name: 'Race weekend' })).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: /not (yet )?confirmed/i })).toBeVisible();
  await expect(page.getByText('Guaranteed entry')).toHaveCount(0);
  await page.goto(`/races?q=${run}`);
  await expect(page.getByRole('link', { name: new RegExp(raceName) }).first()).toBeVisible();
  await page.goto('/admin/races');
  await searchRaces(page, run);
  await expect(page.getByRole('link', { name: raceName, exact: true })).toBeVisible();

  // Copy the package to the next edition.
  await page.goto(raceUrl);
  f = formWith(page, 'Add edition');
  await f.getByLabel('Year').fill('2028');
  await f.getByRole('button', { name: 'Add edition', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/editions\/[0-9a-f-]{36}$/);
  await page.goto(packageUrl);
  f = formWith(page, 'Copy package');
  await f.getByLabel('Copy to edition').selectOption({ label: '2028' });
  await f.getByLabel('Web address (slug)').fill('race-weekend-2028');
  await f.getByLabel('Check-in date').fill('2028-07-07');
  await f.getByLabel('Check-out date').fill('2028-07-10');
  await f.getByLabel('Balance due date').fill('2028-05-07');
  await f.getByRole('button', { name: 'Copy package' }).click();
  await expect(page).toHaveURL(/\/admin\/packages\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Current status: Draft.')).toBeVisible();
  await expect(page.getByText('Deposit: AUD 500.00 per person.')).toBeVisible();
  await expect(page.getByText('Marathon, from Entry stock')).toBeVisible();
  expect((await page.request.get(`/api/catalogue/races/${slug}/editions/2028/packages/race-weekend-2028`)).status()).toBe(404);
});

test('catalogue_csv_check_import_and_export', async ({ page }) => {
  test.setTimeout(120_000);
  const run = `e2c${Date.now().toString(36)}`;
  await signIn(page, owner('E2E_STAFF_5'));
  await page.goto('/admin/races');
  const header = 'slug,name,countryCode,city,timeZone,raceType,typicalMonth,summary,websiteUrl';
  const row = (s: string) => `${s},${s} Run,AU,Cairns,Australia/Brisbane,road,6,A scenic course.,`;

  // A bad file imports nothing and says where the problem is, without echoing the value.
  const file = page.getByLabel('CSV file');
  await file.setInputFiles({ name: 'races.csv', mimeType: 'text/csv', buffer: Buffer.from([header, row(`${run}-a`).replace(',AU,', ',Australia,')].join('\n')) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('The file has problems. Nothing was imported.')).toBeVisible();
  await expect(page.getByText('Row 1, column countryCode: the value is not valid')).toBeVisible();

  // A good file: check, then import. Imported races are drafts.
  await file.setInputFiles({ name: 'races.csv', mimeType: 'text/csv', buffer: Buffer.from([header, row(`${run}-a`), row(`${run}-b`)].join('\n')) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('The file is valid: 2 rows ready to import.')).toBeVisible();
  await page.getByRole('button', { name: 'Import records' }).click();
  await expect(page.getByText('Imported 2 records.')).toBeVisible();
  await searchRaces(page, run);
  await expect(page.getByRole('table', { name: 'Races' }).getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('table', { name: 'Races' }).getByRole('cell', { name: 'Draft' })).toHaveCount(2);

  // The same names again are refused; the export carries them.
  await page.getByLabel('CSV file').setInputFiles({ name: 'again.csv', mimeType: 'text/csv', buffer: Buffer.from([header, row(`${run}-a`)].join('\n')) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('this web address (slug) is already in use').first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^catalogue-races-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain(`${run}-a`);
  expect(text).toContain('slug,name,countryCode');
  // None of them is public.
  expect((await page.request.get(`/api/catalogue/races/${run}-a`)).status()).toBe(404);
});
