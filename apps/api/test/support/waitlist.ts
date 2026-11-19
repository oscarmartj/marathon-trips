import { STATE_HEADERS } from './auth';
import type { TestApp } from './auth';
import { bookingStaff, contact, customerClient, requestBody, staffCancel } from './bookings';
import type { CustomerClient } from './bookings';
import { setSale } from './catalogue';
import { pricedWorld } from './pricing';
import type { PricedWorld } from './pricing';

type Admin = Awaited<ReturnType<typeof bookingStaff>>;

export interface SoldOutWorld {
  w: PricedWorld;
  admin: Admin;
  /** Hold all the places the package had until `cancelHolder` runs. */
  holder: CustomerClient;
  holderBookingId: string;
  holderBookingIds: string[];
  pools: string[];
}

/**
 * A package whose stock one customer holds in full (capacity set to what that request took) and whose sale is then
 * set to `sold_out`. Cancelling the holder's request gives the stock back.
 */
export async function soldOutWorld(t: TestApp, admin: Admin, w?: PricedWorld, holders = 1): Promise<SoldOutWorld> {
  const world = w ?? (await pricedWorld(admin));
  const holder = await customerClient(t);
  const ids: string[] = [];
  for (let i = 0; i < holders; i++) {
    const res = await (i === 0 ? holder : await customerClient(t)).request(requestBody(world));
    if (res.status !== 201) throw new Error(`holder request failed: ${res.status} ${JSON.stringify(res.body)}`);
    ids.push((await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string } })).id);
  }
  const pools = [world.roomPoolId, world.entryPoolId, world.extraPoolId];
  for (const id of pools) {
    const p = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } });
    if (p.consumed > 0) await t.prisma.inventoryPool.update({ where: { id }, data: { capacity: p.consumed } });
  }
  const sale = await setSale(admin, world.pkg.id, 'sold_out');
  if (sale.status !== 200) throw new Error(`sold_out failed: ${sale.status} ${JSON.stringify(sale.body)}`);
  return { w: world, admin, holder, holderBookingId: ids[0]!, holderBookingIds: ids, pools };
}

/** Staff cancel the holder's request; the places come back and the waiting list is offered them. */
export async function cancelHolder(t: TestApp, s: SoldOutWorld, id = s.holderBookingId): Promise<void> {
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id } });
  const r = await staffCancel(s.admin, b.id, { version: b.version, reason: 'Test' });
  if (r.status !== 200) throw new Error(`cancel failed: ${r.status} ${JSON.stringify(r.body)}`);
}

/** A resident joins the list for the package; returns the entry id. */
export async function joinList(t: TestApp, c: CustomerClient, w: PricedWorld, over: Record<string, unknown> = {}): Promise<string> {
  const res = await c.request(requestBody(w, { contact: contact(), ...over }));
  if (res.status !== 201 || res.body.outcome !== 'waitlisted') throw new Error(`join failed: ${res.status} ${JSON.stringify(res.body)}`);
  const e = await t.prisma.waitlistEntry.findFirstOrThrow({ where: { customer: { userId: c.userId }, packageId: w.pkg.id }, orderBy: { position: 'desc' } });
  return e.id;
}

export const act = (t: TestApp, c: { cookie: string }, id: string, what: 'accept' | 'withdraw') =>
  t.http().post(`/waitlist/entries/${id}/${what}`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
export const viewOf = (t: TestApp, c: { cookie: string }, id: string) => t.http().get(`/waitlist/entries/${id}`).set('Cookie', c.cookie);
