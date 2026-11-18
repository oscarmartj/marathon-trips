import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/platform/database/prisma.service';
import { EventsService } from '../src/platform/events/events.service';
import { MAIL_SENDER, type MailMessage, type MailSender } from '../src/platform/mail/mail-sender';
import { MailService } from '../src/platform/mail/mail.service';

/**
 * Task 5.7 (rehearsal). Lets an end-to-end test do what the background workers do when they are off, without a mailbox:
 * delivers the events recorded so far (the opening notice consumer only), then sends the queued emails of the given addresses through the
 * real mail service with a sender that only captures. Prints { sent: [{ to, subject, token? }], queued: [{ to, templateKey, status }] }
 * as JSON. `token` is the value after `#token=` in the body, so the test can open the confirm page. Nothing leaves the
 * process. Not an HTTP route; refuses to run outside test and ci. Usage: tsx scripts/e2e-mail.ts a@example.test [b@example.test ...]
 */
class Capture implements MailSender {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<{ providerMessageId: string }> {
    this.sent.push(m);
    return { providerMessageId: `e2e-${this.sent.length}` };
  }
}

async function main(): Promise<void> {
  const env = process.env.APP_ENV;
  if (env !== 'test' && env !== 'ci') throw new Error('e2e-mail runs only with APP_ENV=test or ci');
  process.env.JOBS_WORKERS = 'off';
  const addresses = process.argv.slice(2).map((a) => a.toLowerCase());
  if (addresses.length === 0 || addresses.some((a) => !/^[^@\s]+@example\.test$/.test(a))) throw new Error('give addresses ending in @example.test');
  const capture = new Capture();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_SENDER).useValue(capture).compile();
  const app = mod.createNestApplication({ logger: ['error'] });
  await app.init();
  try {
    const prisma = app.get(PrismaService);
    const events = app.get(EventsService);
    await events.dispatchPending(500);
    const pending = await prisma.eventDelivery.findMany({ where: { status: 'pending', consumer: 'alerts.notify_open' }, select: { id: true } });
    for (const d of pending) await events.processDelivery(d.id);
    const mail = app.get(MailService);
    const rows = await prisma.outboundEmail.findMany({ where: { to: { in: addresses } }, orderBy: { createdAt: 'asc' }, select: { id: true, to: true, templateKey: true, status: true } });
    for (const r of rows) if (r.status === 'queued') await mail.processSend(r.id);
    const after = await prisma.outboundEmail.findMany({ where: { to: { in: addresses } }, orderBy: { createdAt: 'asc' }, select: { to: true, templateKey: true, status: true } });
    const sent = capture.sent.filter((m) => addresses.includes(m.to.toLowerCase())).map((m) => ({ to: m.to, subject: m.subject, token: /#token=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1] ?? null }));
    process.stdout.write(JSON.stringify({ sent, queued: after }));
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : 'e2e-mail failed');
    process.exit(1);
  },
);
