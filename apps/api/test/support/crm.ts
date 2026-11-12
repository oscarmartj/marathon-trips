import { STATE_HEADERS, TestApp, uniqueEmail } from './auth';
import type { StaffFixture } from './auth';
import { CATALOGUE_AND_PRICING, Client, staffClient } from './catalogue';
import { ALL_BOOKING_PERMISSIONS, customerClient } from './bookings';
import type { CustomerClient } from './bookings';
import { quoteBody } from './pricing';
import type { PricedWorld } from './pricing';
import { CRM_PERMISSIONS } from '../../src/modules/crm';
import { BOOKINGS_CRM_PERMISSIONS } from '../../src/modules/bookings';

export const ALL_CUSTOMER_PERMISSIONS = Object.values(BOOKINGS_CRM_PERMISSIONS);
export const ALL_CRM_PERMISSIONS = Object.values(CRM_PERMISSIONS);

/** Staff that can run the catalogue and prices, handle bookings and customers, and make quotes. */
export const crmStaff = (t: TestApp): Promise<Client & { staff: StaffFixture }> =>
  staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_CUSTOMER_PERMISSIONS, ...ALL_CRM_PERMISSIONS]);

/** The configuration of a quote: the priced world's default (a runner and a supporter in the double), no promo code. */
export const quoteConfiguration = (w: PricedWorld, over: Record<string, unknown> = {}) => quoteBody(w, over);

/** A customer row (as staff would add one) linked to a signed-in customer user, so that user can accept its quotes. */
export async function linkedCustomer(t: TestApp, over: Record<string, unknown> = {}): Promise<{ client: CustomerClient; customerId: string }> {
  const client = await customerClient(t, uniqueEmail('quoted'));
  const c = await t.prisma.customer.create({ data: { userId: client.userId, email: client.email, givenName: 'Quinn', familyName: 'Quoted', countryOfResidence: 'AU', source: 'panel', ...over } });
  return { client, customerId: c.id };
}

export interface MadeQuote {
  id: string;
  reference: string;
  version: number;
  customerId: string;
}

export async function makeQuote(admin: Client, customerId: string, w: PricedWorld, over: Record<string, unknown> = {}): Promise<MadeQuote> {
  const res = await admin.post('/admin/quotes', { customerId, configuration: quoteConfiguration(w), ...over });
  if (res.status !== 200 && res.status !== 201) throw new Error(`quote failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, reference: res.body.reference, version: res.body.version, customerId };
}

export async function sendQuote(admin: Client, q: MadeQuote): Promise<MadeQuote> {
  const res = await admin.post(`/admin/quotes/${q.id}/send`, { version: q.version });
  if (res.status !== 200) throw new Error(`send failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...q, version: res.body.version };
}

export const acceptQuote = (t: TestApp, c: CustomerClient, reference: string) => t.http().post(`/quotes/${reference}/accept`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});

/** Fixture for the ownership harness: a quote sent to the customer with this session; returns its reference. */
export async function sentQuoteFixture(t: TestApp, session: { userId: string; cookie: string }): Promise<string> {
  const { pricedWorld } = await import('./pricing');
  const admin = await crmStaff(t);
  const w = await pricedWorld(admin);
  const user = await t.prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
  const c = (await t.prisma.customer.findUnique({ where: { userId: user.id } })) ?? (await t.prisma.customer.create({ data: { userId: user.id, email: user.email, givenName: 'Fixture', familyName: 'Customer', countryOfResidence: 'AU', source: 'panel' } }));
  const q = await sendQuote(admin, await makeQuote(admin, c.id, w));
  return q.reference;
}
