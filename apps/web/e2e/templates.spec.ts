import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

interface Staff {
  email: string;
  password: string;
  secret: string;
}
// Slot 10 holds read, manage and publish for templates; slot 11 holds read and manage only (see global-setup.ts).
const publisher = (): Staff => JSON.parse(process.env.E2E_STAFF_10 ?? '{}') as Staff;
const drafter = (): Staff => JSON.parse(process.env.E2E_STAFF_11 ?? '{}') as Staff;
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

async function open(page: Page, kind: 'Emails' | 'Documents', template: string) {
  await page.goto('/admin/templates');
  await expect(page.getByRole('heading', { level: 1, name: 'Email and document templates' })).toBeVisible();
  await page.getByLabel('Kind', { exact: true }).selectOption({ label: kind });
  await page.getByLabel('Template', { exact: true }).selectOption({ label: template });
  await expect(page.getByRole('heading', { level: 2, name: 'Wording' })).toBeVisible();
}

test.use({ actionTimeout: 15_000 });

// Task 5.4: wording is drafted, previewed (text and PDF), put into use by someone who may, and refused to someone who may not.
test('template_draft_preview_pdf_publish_and_permission', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const run = `e2e${Date.now().toString(36)}`;
  await signIn(page, publisher());

  try {
    // Draft an email from the suggested wording, then change the draft.
    await open(page, 'Emails', 'Booking request approved');
    await expect(page.getByRole('heading', { level: 2, name: 'Variables you can use' })).toBeVisible();
    await expect(page.getByText('{{givenName}}', { exact: false }).first()).toBeVisible();
    await page.getByLabel('Subject', { exact: true }).fill(`${run} approved {{reference}}`);
    await page.getByLabel('Body', { exact: true }).fill('Hi {{givenName}}, your places for {{trip}} are held. {{link}}');
    await page.getByRole('button', { name: 'Save as a new draft', exact: true }).click();
    await expect(page.getByText(/Saved as draft revision \d+\./)).toBeVisible();
    await expect(page.getByText(/Editing draft revision \d+\./)).toBeVisible();
    await page.getByLabel('Body', { exact: true }).fill('Hi {{givenName}}, good news about {{trip}}. {{link}}');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible();

    // Preview with sample data; nothing real is used.
    await page.getByRole('button', { name: 'Preview with sample data', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(preview.getByText(`Subject: ${run} approved BK-7QX4MD`)).toBeVisible();
    await expect(preview.getByText('Hi Alex, good news about Sample City Marathon 2027: Marathon weekend.')).toBeVisible();

    // A variable the template does not have is reported, not previewed.
    await page.getByLabel('Body', { exact: true }).fill('Hi {{passportNumber}}');
    await page.getByRole('button', { name: 'Preview with sample data', exact: true }).click();
    await expect(preview.getByRole('alert')).toContainText('the variable passportNumber is not available');
    await page.getByLabel('Body', { exact: true }).fill('Hi {{givenName}}, good news about {{trip}}. {{link}}');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible();

    // A document: draft it, open its PDF preview.
    await open(page, 'Documents', 'Voucher');
    await page.getByLabel('Title', { exact: true }).fill(`${run} voucher`);
    await page.getByLabel('Body', { exact: true }).fill('Voucher for {{customerName}}, booking {{reference}}.');
    await page.getByRole('button', { name: 'Save as a new draft', exact: true }).click();
    await expect(page.getByText(/Saved as draft revision \d+\./)).toBeVisible();
    const pdfLink = page.getByRole('link', { name: 'Open PDF preview' }).first();
    const href = await pdfLink.getAttribute('href');
    expect(href).toMatch(/^\/api\/admin\/templates\/document\/[0-9a-f-]{36}\/pdf$/);
    const pdf = await page.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    const bytes = (await pdf.body()).toString('latin1');
    expect(bytes.startsWith('%PDF-')).toBe(true);
    expect(bytes).toContain(`(${run} voucher) Tj`);
    expect(bytes).toContain('Voucher for Alex Sample, booking BK-7QX4MD.');

    // Put the document into use: the row says so.
    const docRow = page.getByRole('table', { name: 'Revisions of this template, newest first' }).getByRole('row').filter({ hasText: 'Draft' }).first();
    await docRow.getByRole('button', { name: 'Put into use' }).click();
    await expect(page.getByText(/Revision \d+ is now in use\./)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Revisions of this template, newest first' }).getByRole('row').filter({ hasText: 'In use' })).toHaveCount(1);

    // Someone who can draft but not put into use is refused, and the API agrees.
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      const other = await ctx.newPage();
      await signIn(other, drafter());
      await open(other, 'Emails', 'Booking request approved');
      await other.getByLabel('Subject', { exact: true }).fill(`${run} limited {{reference}}`);
      await other.getByLabel('Body', { exact: true }).fill('Hi {{givenName}}.');
      await other.getByRole('button', { name: 'Save as a new draft', exact: true }).click();
      await expect(other.getByText(/Saved as draft revision \d+\./)).toBeVisible();
      const row = other.getByRole('table', { name: 'Revisions of this template, newest first' }).getByRole('row').filter({ hasText: 'Draft' }).first();
      await row.getByRole('button', { name: 'Put into use' }).click();
      await expect(other.getByText('You do not have permission to do this.')).toBeVisible();
      await expect(row).toContainText('Draft');
      const list = await (await other.request.get('/api/admin/templates/email?key=crm.booking_approved', { headers: STATE })).json();
      const mine = (list.items as Array<{ id: string; version: number; subject: string }>).find((r) => r.subject.startsWith(`${run} limited`))!;
      const denied = await other.request.post(`/api/admin/templates/email/${mine.id}/activate`, { headers: STATE, data: { version: mine.version } });
      expect(denied.status()).toBe(403);
    } finally {
      await ctx.close();
    }
  } finally {
    // Leave nothing in use for the other specs: archive everything this run made.
    for (const [channel, key] of [['email', 'crm.booking_approved'], ['document', 'voucher']] as const) {
      const res = await page.request.get(`/api/admin/templates/${channel}?key=${key}`, { headers: STATE });
      if (res.status() !== 200) continue;
      for (const r of ((await res.json()).items ?? []) as Array<{ id: string; version: number; status: string; subject: string }>) {
        if (r.status !== 'archived' && r.subject.startsWith(run)) await page.request.post(`/api/admin/templates/${channel}/${r.id}/archive`, { headers: STATE, data: { version: r.version } });
      }
    }
  }
});
