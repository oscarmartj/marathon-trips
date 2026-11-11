import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emailHash } from '../../src/platform/crypto/hmac';
import { AppError } from '../../src/platform/errors/safe-error';
import { evaluateMailGuard, isLiveMail } from '../../src/platform/mail/mail-guard';
import { MailMessage, MailSender } from '../../src/platform/mail/mail-sender';
import { MailService } from '../../src/platform/mail/mail.service';
import { SmtpMailSender } from '../../src/platform/mail/smtp-mail-sender';
import { MailTemplateRegistry } from '../../src/platform/mail/templates';
import { startFakeSmtp } from '../support/fake-smtp';
import { Platform, makePlatform, newId } from '../support/platform';

describe('mail guard (plan 4.6)', () => {
  const cfg = (APP_ENV: string, MAIL_MODE: string, MAIL_DEV_ALLOWLIST = 'example.test,example.com') => ({ APP_ENV: APP_ENV as 'test', MAIL_MODE, MAIL_DEV_ALLOWLIST });
  // [APP_ENV, MAIL_MODE, recipient, allowed]
  const table: Array<[string, string, string, boolean]> = [
    ['development', 'catch', 'a@example.test', true],
    ['development', 'catch', 'a@example.com', true],
    ['development', 'catch', 'A@Example.COM', true],
    ['development', 'catch', 'real.person@gmail.com', false],
    ['development', 'catch', 'a@sub.example.com', false],
    ['development', 'catch', 'a@example.com.evil.net', false],
    ['development', 'catch', 'not-an-address', false],
    ['development', 'live', 'real.person@gmail.com', false], // live is ignored outside production
    ['staging', 'live', 'real.person@gmail.com', false],
    ['test', 'live', 'real.person@gmail.com', false],
    ['production', 'live', 'real.person@gmail.com', true],
    ['production', 'catch', 'real.person@gmail.com', false],
    ['production', 'LIVE', 'real.person@gmail.com', false], // unknown value counts as not live
    ['production', '', 'real.person@gmail.com', false],
    ['production', 'live ', 'real.person@gmail.com', false],
  ];
  it.each(table)('APP_ENV=%s MAIL_MODE=%j to %s -> allowed=%s', (env, mode, to, allowed) => {
    expect(evaluateMailGuard(cfg(env, mode), to).allowed).toBe(allowed);
  });
  it('warns when live is set outside production', () => {
    expect(isLiveMail(cfg('staging', 'live'))).toMatchObject({ live: false, warning: expect.stringContaining('ignored') });
    expect(isLiveMail(cfg('production', 'live'))).toEqual({ live: true });
  });
  it('an allowlist entry with @ matches one address only', () => {
    expect(evaluateMailGuard(cfg('development', 'catch', 'qa@corp.test'), 'qa@corp.test').allowed).toBe(true);
    expect(evaluateMailGuard(cfg('development', 'catch', 'qa@corp.test'), 'other@corp.test').allowed).toBe(false);
  });
});

class FakeSender implements MailSender {
  sent: MailMessage[] = [];
  failures = 0;
  async send(m: MailMessage) {
    if (this.failures > 0) { this.failures -= 1; throw new AppError('smtp_send_failed', 'The mail server could not accept the message'); }
    this.sent.push(m);
    return { providerMessageId: `<fake-${this.sent.length}@test>` };
  }
}

describe('mail service', () => {
  let p: Platform;
  let sender: FakeSender;
  let templates: MailTemplateRegistry;
  let mail: MailService;
  const tokenRows: string[] = [];

  const rebuild = (overrides: Record<string, string> = {}) => {
    sender = new FakeSender();
    templates = new MailTemplateRegistry();
    templates.register({
      key: 'test-welcome', version: 1,
      render: async ({ tx, email, unsubscribeToken }) => {
        // Stands in for minting a one-time token: its hash is written in the send transaction.
        const hashKey = `test-token-hash-${email.id}`;
        await tx.setting.upsert({ where: { key: hashKey }, create: { key: hashKey, value: {} }, update: {} });
        tokenRows.push(hashKey);
        return { subject: 'Welcome', text: `Hello, your link is https://example.test/t/SECRET-PLAINTEXT-${email.id} ${unsubscribeToken}` };
      },
    });
    mail = new MailService(p.prisma, { ...p.config, ...overrides } as typeof p.config, p.jobs, sender, templates);
  };

  beforeAll(async () => {
    p = await makePlatform();
    rebuild();
  });
  afterAll(async () => p.close());
  afterEach(async () => {
    rebuild();
    await p.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send' AND singleton_key IN (SELECT id::text FROM outbound_emails WHERE "dedupeKey" LIKE 'test:%')`);
    await p.prisma.outboundEmail.deleteMany({ where: { dedupeKey: { startsWith: 'test:' } } });
    await p.prisma.setting.deleteMany({ where: { key: { startsWith: 'test-token-hash-' } } });
    await p.prisma.emailSuppression.deleteMany({});
  });

  const input = (over: Record<string, unknown> = {}) => ({ to: 'guest@example.test', templateKey: 'test-welcome', templateVersion: 1, locale: 'en-AU', dedupeKey: `test:${newId()}`, ...over });

  it('OutboundEmail.dedupeKey: one fact, one email and one job, even when enqueued twice or concurrently', async () => {
    const i = input();
    const results = await Promise.all([mail.enqueue(i), mail.enqueue(i), mail.enqueue(i)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await p.prisma.outboundEmail.count({ where: { dedupeKey: i.dedupeKey } })).toBe(1);
    const jobs = await p.prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pgboss.job WHERE name = 'mail.send' AND singleton_key = $1`, results[0]!.id);
    expect(jobs).toHaveLength(1);
  });

  it('a rolled back transaction queues no email and no job', async () => {
    const i = input();
    await expect(p.prisma.$transaction(async (tx) => { await mail.enqueue(i, tx); throw new Error('rollback'); })).rejects.toThrow();
    expect(await p.prisma.outboundEmail.count({ where: { dedupeKey: i.dedupeKey } })).toBe(0);
  });

  it('sends to an allowed address once, stores the subject and a fingerprint but never the body', async () => {
    const { id } = await mail.enqueue(input());
    expect(await mail.processSend(id)).toBe('sent');
    expect(await mail.processSend(id)).toBe('noop'); // a repeated job never sends twice
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ to: 'guest@example.test', subject: 'Welcome' });
    const row = await p.prisma.outboundEmail.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'sent', subject: 'Welcome', attempts: 1 });
    expect(row.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('SECRET-PLAINTEXT');
    expect(row.sentAt).not.toBeNull();
  });

  it('one_time_tokens_never_persisted_in_plaintext: a failed send rolls back the token minted in render; a retry mints a new one', async () => {
    const { id } = await mail.enqueue(input());
    sender.failures = 1;
    await expect(mail.processSend(id)).rejects.toMatchObject({ code: 'smtp_send_failed' });
    expect(await p.prisma.setting.count({ where: { key: `test-token-hash-${id}` } })).toBe(0); // rolled back with the failed attempt
    expect(await p.prisma.outboundEmail.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'queued', attempts: 1, error: 'smtp_send_failed: The mail server could not accept the message' });
    expect(await mail.processSend(id)).toBe('sent');
    expect(await p.prisma.setting.count({ where: { key: `test-token-hash-${id}` } })).toBe(1);
    const dump = JSON.stringify(await p.prisma.outboundEmail.findUniqueOrThrow({ where: { id } }));
    expect(dump).not.toContain('SECRET-PLAINTEXT');
  });

  it('marks the email failed after five attempts and keeps only a code (no address)', async () => {
    const { id } = await mail.enqueue(input());
    sender.failures = 99;
    for (let i = 0; i < 4; i += 1) await expect(mail.processSend(id)).rejects.toThrow();
    expect(await mail.processSend(id)).toBe('failed');
    const row = await p.prisma.outboundEmail.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'failed', attempts: 5 });
    expect(row.error).not.toContain('guest@');
  });

  it('suppresses a recipient outside the dev allowlist: nothing is sent and no template is rendered', async () => {
    const { id } = await mail.enqueue(input({ to: 'real.person@gmail.com' }));
    expect(await mail.processSend(id)).toBe('suppressed');
    expect(sender.sent).toHaveLength(0);
    expect(await p.prisma.outboundEmail.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'suppressed', error: 'recipient_not_on_dev_allowlist' });
    expect(await p.prisma.setting.count({ where: { key: `test-token-hash-${id}` } })).toBe(0);
  });

  it('MAIL_MODE=live outside production still suppresses real recipients', async () => {
    rebuild({ MAIL_MODE: 'live', APP_ENV: 'staging' });
    const { id } = await mail.enqueue(input({ to: 'real.person@gmail.com' }));
    expect(await mail.processSend(id)).toBe('suppressed');
    expect(sender.sent).toHaveLength(0);
  });

  it('marketing mail consults EmailSuppression (HMAC only); transactional mail does not', async () => {
    await mail.addSuppression('Guest@Example.test', 'unsubscribed', 'marketing');
    const stored = await p.prisma.emailSuppression.findFirstOrThrow({});
    expect(stored.emailHash).toBe(emailHash(p.config.EMAIL_HASH_KEY, 'guest@example.test'));
    expect(JSON.stringify(stored)).not.toContain('guest');
    const marketing = await mail.enqueue(input({ category: 'marketing' }));
    const transactional = await mail.enqueue(input());
    expect(await mail.processSend(marketing.id)).toBe('suppressed');
    expect(await p.prisma.outboundEmail.findUniqueOrThrow({ where: { id: marketing.id } })).toMatchObject({ error: 'recipient_suppressed' });
    expect(await mail.processSend(transactional.id)).toBe('sent');
  });

  it('marketing mail carries a List-Unsubscribe header built from an HMAC, not a stored token', async () => {
    const { id } = await mail.enqueue(input({ category: 'marketing' }));
    await mail.processSend(id);
    expect(sender.sent[0]!.headers?.['List-Unsubscribe']).toMatch(new RegExp(`/unsubscribe/${id}\\.[0-9a-f]{64}>$`));
  });

  it('fails permanently when no template is registered for the email', async () => {
    const { id } = await mail.enqueue(input({ templateKey: 'test-unknown' }));
    expect(await mail.processSend(id)).toBe('failed');
    expect(sender.sent).toHaveLength(0);
  });
});

describe('SmtpMailSender', () => {
  it('delivers to an SMTP server and returns the message id', async () => {
    const smtp = await startFakeSmtp();
    const sender = new SmtpMailSender('127.0.0.1', smtp.port);
    const out = await sender.send({ from: 'Marathon Trips <no-reply@example.test>', to: 'guest@example.test', subject: 'Hi', text: 'Body text' });
    sender.close();
    await smtp.close();
    expect(out.providerMessageId).toMatch(/^<.+>$/);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]!.to.join()).toContain('guest@example.test');
    expect(smtp.received[0]!.data).toContain('Body text');
  });

  it('reports a refused connection as smtp_send_failed without quoting the recipient', async () => {
    const smtp = await startFakeSmtp();
    const port = smtp.port;
    await smtp.close();
    const sender = new SmtpMailSender('127.0.0.1', port);
    const err = await sender.send({ from: 'a@example.test', to: 'secret.person@example.test', subject: 's', text: 't' }).catch((e: unknown) => e);
    sender.close();
    expect(err).toMatchObject({ code: 'smtp_send_failed' });
    expect(String((err as Error).message)).not.toContain('secret.person');
  });
});
