import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import type { AppConfig } from '../../../platform/config/config';
import { bossDb } from '../../../platform/database/boss-db';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { hmacHex, sha256Hex } from '../../../platform/crypto/hmac';
import { safeError } from '../../../platform/errors/safe-error';
import { ApiError, notFound } from '../../../platform/http/api-error';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { readBookingForPayments } from '../../bookings';
import { PaymentStateMachine, lockPayment } from './attempt-state';
import { PAYMENT_TX_OPTIONS, PaymentAttemptsService } from './attempts.service';
import { ACCOUNT_PUBLIC_SELECT, ProviderGateway } from './gateway';

export const WEBHOOK_PATH_PREFIX = '/payments/webhooks';
export const WEBHOOK_MAX_BYTES = 256 * 1024;
/** Path tokens are 32 random bytes in base64url. */
const PATH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Headers kept with an event or a rejection; signature headers are kept by name only. */
const KEPT_HEADERS = ['content-type', 'content-length', 'user-agent'];

export const webhookPathTokenHash = (key: string, token: string): string => hmacHex(key, `payments.webhook_path:${token}`);

export type ProcessOutcome = 'processed' | 'ignored' | 'skipped';

/**
 * Incoming gateway webhooks (plan 3.1, section 6). Receiving: account by the hash of the path token, signature checked
 * with that account's secret, the raw event stored once per gateway event id and a job queued in the same transaction.
 * Processing: the payment is matched first by our id (from the same account), then by the gateway reference, then the
 * state machine moves it forward. Unknown paths and oversized bodies never reach the database.
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger('PaymentWebhooks');
  readonly counters = { unknownAccount: 0 };

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentStateMachine) private readonly machine: PaymentStateMachine,
    @Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  sanitiseHeaders(headers: Record<string, string | string[] | undefined>, signatureHeaders: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of KEPT_HEADERS) {
      const v = headers[k];
      if (typeof v === 'string') out[k] = v.slice(0, 200);
    }
    for (const k of signatureHeaders) if (headers[k] !== undefined) out[k] = '[present]';
    return out;
  }

  async receive(pathToken: string, rawBody: unknown, headers: Record<string, string | string[] | undefined>, now: Date = new Date()): Promise<{ received: true; duplicate: boolean }> {
    if (!Buffer.isBuffer(rawBody)) throw new ApiError(400, 'bad_request', 'The request could not be read');
    const account = PATH_TOKEN.test(pathToken)
      ? await this.prisma.providerAccount.findUnique({ where: { webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken) }, select: ACCOUNT_PUBLIC_SELECT })
      : null;
    if (!account) {
      // No row for an unknown path: a counter and a code only (plan 3.1, section 14, point 5).
      this.counters.unknownAccount++;
      this.logger.warn('payment webhook: unknown_account');
      throw notFound();
    }
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') flat[k.toLowerCase()] = v;
    const signatureHeaders = this.gateway.signatureHeaders(account.adapterKey);
    const verdict = await this.gateway.verifyWebhook(account, rawBody, flat, now);
    if (!verdict.ok) {
      await this.prisma.webhookRejection.create({
        data: {
          providerAccountId: account.id, reason: verdict.code, bodySha256: sha256Hex(rawBody), sizeBytes: rawBody.length,
          claimedEventId: verdict.claimedEventId ?? null, headers: this.sanitiseHeaders(headers, signatureHeaders),
        },
      });
      throw new ApiError(400, 'webhook_rejected', 'The webhook was rejected');
    }
    const event = verdict.event;
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.webhookEvent.createMany({
        data: [{ providerAccountId: account.id, providerEventId: event.providerEventId, type: event.kind, rawBody: new Uint8Array(rawBody), headers: this.sanitiseHeaders(headers, signatureHeaders) }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return { received: true as const, duplicate: true };
      const row = await tx.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: account.id, providerEventId: event.providerEventId } }, select: { id: true } });
      await this.jobs.send(QUEUES.paymentsWebhooks, { webhookEventId: row.id }, { db: bossDb(tx), singletonKey: `webhook:${row.id}` });
      return { received: true as const, duplicate: false };
    });
  }

  /** Processes one stored event; safe to run twice. A failure is recorded with its code and rethrown for the job to retry. */
  async process(webhookEventId: string): Promise<ProcessOutcome> {
    try {
      return await this.processOnce(webhookEventId);
    } catch (err) {
      await this.prisma.webhookEvent.updateMany({ where: { id: webhookEventId, status: { in: ['received', 'failed'] } }, data: { status: 'failed', attempts: { increment: 1 }, errorCode: safeError(err).code.slice(0, 64) } });
      throw err;
    }
  }

  private async processOnce(webhookEventId: string): Promise<ProcessOutcome> {
    const ev = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId }, select: { id: true, providerAccountId: true, providerEventId: true, rawBody: true, status: true, providerAccount: { select: { adapterKey: true } } } });
    if (!ev) throw notFound();
    if (ev.status !== 'received' && ev.status !== 'failed') return 'skipped';
    const provider = this.gateway.registry.get(ev.providerAccount.adapterKey);
    const parsed = ev.rawBody && provider ? provider.parseEvent(Buffer.from(ev.rawBody)) : null;
    if (!parsed) return this.ignore(ev.id, ev.rawBody ? 'malformed' : 'body_purged');
    if (parsed.kind !== 'payment' || !parsed.payment) return this.ignore(ev.id, 'unsupported');
    const remote = parsed.payment;

    // Match first by our id, only among this account's payments; then by the gateway reference (plan 0.1, P5).
    const byId = remote.ourPaymentId && UUID.test(remote.ourPaymentId)
      ? await this.prisma.payment.findFirst({ where: { id: remote.ourPaymentId, providerAccountId: ev.providerAccountId }, select: { id: true, bookingId: true } })
      : null;
    const match = byId ?? await this.prisma.payment.findFirst({ where: { providerAccountId: ev.providerAccountId, providerPaymentRef: remote.ref }, select: { id: true, bookingId: true } });
    if (!match) {
      return runTransaction(this.prisma, async (tx) => {
        await this.tasks.createSystemIn(tx, {
          title: 'Payment webhook for an unknown payment',
          description: 'A payment gateway sent an event for a payment we cannot match. If money came in, register it against the right booking.',
          entityType: 'WebhookEvent', entityId: ev.id, sourceRef: `payments:unknown_event:${ev.id}`,
        });
        return this.ignoreIn(tx, ev.id, 'unknown_payment');
      });
    }

    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: match.bookingId }, true);
      const p = await lockPayment(tx, match.id);
      if (!b || !p) throw notFound();
      const current = await tx.webhookEvent.findUniqueOrThrow({ where: { id: ev.id }, select: { status: true } });
      if (current.status !== 'received' && current.status !== 'failed') return 'skipped' as const;
      await tx.webhookEvent.update({ where: { id: ev.id }, data: { bookingId: b.id, paymentId: p.id } });
      if (p.providerPaymentRef !== null && p.providerPaymentRef !== remote.ref) {
        await this.attempts.mismatchTask(tx, p, b.reference);
        return this.ignoreIn(tx, ev.id, 'reference_mismatch');
      }
      if (remote.amount.amountMinor !== p.amountMinor || remote.amount.currency !== p.currency) {
        await this.attempts.mismatchTask(tx, p, b.reference);
        return this.ignoreIn(tx, ev.id, 'amount_or_currency_mismatch');
      }
      await this.machine.setReference(tx, p, remote.ref);
      await this.machine.apply(tx, p, remote.status, { source: 'webhook', failureCode: remote.failureCode, bookingReference: b.reference });
      await tx.webhookEvent.update({ where: { id: ev.id }, data: { status: 'processed', processedAt: new Date(), attempts: { increment: 1 }, errorCode: null } });
      return 'processed' as const;
    }, PAYMENT_TX_OPTIONS);
  }

  private ignore(id: string, code: string): Promise<ProcessOutcome> {
    return this.prisma.$transaction((tx) => this.ignoreIn(tx, id, code));
  }

  private async ignoreIn(tx: Prisma.TransactionClient, id: string, code: string): Promise<'ignored'> {
    await tx.webhookEvent.update({ where: { id }, data: { status: 'ignored', processedAt: new Date(), attempts: { increment: 1 }, errorCode: code } });
    return 'ignored';
  }
}
