import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../src/generated/prisma/client';
import { PAYMENTS_PERMISSIONS, ProviderAccountsService } from '../../src/modules/payments';
import { SimulatorControl, SIMULATOR_WORLD } from '../../src/modules/payments/adapters/simulator/simulator';
import type { SignedWebhook } from '../../src/modules/payments/adapters/simulator/simulator';
import { webhookSecretAad } from '../../src/modules/payments/core/gateway';
import { STATE_HEADERS } from './auth';
import type { TestApp } from './auth';
import { ALL_BOOKING_PERMISSIONS, customerClient, requestBody } from './bookings';
import type { CustomerClient } from './bookings';
import { CATALOGUE_AND_PRICING, Client, staffClient } from './catalogue';
import type { PricedWorld } from './pricing';

export const sim = new SimulatorControl(SIMULATOR_WORLD);

type Db = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/**
 * A valid payment plan for a booking, written by SQL as the API role (plan 3.1, section 14, point 1): deposit and
 * balance from the current snapshot, in the caller's transaction. For tests that move a booking to `approved` by SQL,
 * so the "approved booking has a plan whose items add up" check holds at commit.
 */
export async function insertValidSchedule(db: Db, bookingId: string): Promise<void> {
  const [s] = await db.$queryRawUnsafe<Array<{ totalMinor: bigint; depositMinor: bigint; currency: string }>>(
    `SELECT s."totalMinor", s."depositMinor", s.currency FROM bookings b JOIN booking_snapshots s ON s."bookingId" = b.id AND s.version = b."currentSnapshotVersion" WHERE b.id = $1::uuid`, bookingId);
  if (!s) throw new Error('no snapshot');
  const scheduleId = randomUUID();
  await db.$executeRawUnsafe(`INSERT INTO payment_schedules (id, "bookingId", currency, version, "updatedAt") VALUES ($1::uuid, $2::uuid, $3, 1, now())`, scheduleId, bookingId, s.currency);
  let seq = 0;
  for (const [kind, amount] of [['deposit', s.depositMinor], ['balance', s.totalMinor - s.depositMinor]] as const) {
    if (amount <= 0n) continue;
    seq += 1;
    await db.$executeRawUnsafe(
      `INSERT INTO payment_schedule_items (id, "scheduleId", "bookingId", currency, kind, sequence, "planVersion", "amountMinor", "dueDate", "updatedAt")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"PaymentScheduleItemKind", $6::int, 1, $7::bigint, DATE '2027-01-01' + $6::int, now())`,
      randomUUID(), scheduleId, bookingId, s.currency, kind, seq, amount,
    );
  }
}

export const ALL_PAYMENT_PERMISSIONS = Object.values(PAYMENTS_PERMISSIONS);

/** Staff with catalogue, pricing, bookings and payments permissions. */
export const paymentsStaff = (t: TestApp): Promise<Client> => staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);

export interface SimAccount {
  id: string;
  pathToken: string;
  secret: string;
}

/** A simulator account (test mode) with its path token and webhook secret, read back for the test only. */
export async function simulatorAccount(t: TestApp): Promise<SimAccount> {
  const { id, webhookUrl } = await t.app.get(ProviderAccountsService).createSimulatorAccount({ displayName: `Sim ${id8()}` });
  const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } });
  return { id, pathToken: webhookUrl.split('/').pop()!, secret: t.box.decrypt(row.webhookSecretCiphertext, row.webhookKeyVersion, webhookSecretAad(id)) };
}

const id8 = () => Math.random().toString(36).slice(2, 10);

/** Pauses every other active account so routing picks `keep` (tests share one database). */
export async function onlyAccount(t: TestApp, keep: string | null): Promise<void> {
  await t.prisma.providerAccount.updateMany({ where: { status: 'active', ...(keep ? { id: { not: keep } } : {}) }, data: { status: 'paused' } });
}

export interface PayingCustomer extends CustomerClient {
  plan: (ref: string) => ReturnType<ReturnType<TestApp['http']>['get']>;
  pay: (ref: string, body: object, key?: string) => ReturnType<ReturnType<TestApp['http']>['post']>;
}

export async function payingCustomer(t: TestApp): Promise<PayingCustomer> {
  const c = await customerClient(t);
  return {
    ...c,
    plan: (ref) => t.http().get(`/booking-requests/${ref}/payment-plan`).set('Cookie', c.cookie),
    pay: (ref, body, key = randomUUID()) => t.http().post(`/booking-requests/${ref}/payments`).set(STATE_HEADERS).set('Cookie', c.cookie).set('Idempotency-Key', key).send(body),
  };
}

/** A real request by the customer, approved by staff through the API (the approval hook creates the plan). */
export async function approvedBooking(t: TestApp, admin: Client, w: PricedWorld, c: CustomerClient): Promise<{ reference: string; bookingId: string }> {
  const res = await c.request(requestBody(w));
  if (res.status !== 201) throw new Error(`request failed: ${res.status} ${JSON.stringify(res.body)}`);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string } });
  const ok = await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version });
  if (ok.status !== 200) throw new Error(`approve failed: ${ok.status} ${JSON.stringify(ok.body)}`);
  return { reference: b.reference, bookingId: b.id };
}

export const sendWebhook = (t: TestApp, a: SimAccount, w: SignedWebhook) => {
  let r = t.http().post(`/payments/webhooks/${a.pathToken}`);
  for (const [k, v] of Object.entries(w.headers)) r = r.set(k, v);
  return r.send(w.body);
};

/** Removes the jobs and events payments tests leave behind. */
export async function cleanPayments(t: TestApp): Promise<void> {
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE 'payments.%'`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'payments.%' OR type LIKE 'bookings.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'payments.%' OR type LIKE 'bookings.%'`);
}
