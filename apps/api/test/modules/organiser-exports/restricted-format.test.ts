// Organiser exports (7.fix-3, plan docs/plans/7.fix-3-organiser-exports.md, item 4): a format restricted to race A,
// end to end through the API. No shipped format is restricted, so this file adds one: `FORMATS` is replaced by a list
// that starts as the shipped formats, and the test appends a format built with the real `defineFormat` once race A
// exists. The service reads the list on every request.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FormatDefinition } from '../../../src/modules/organiser-exports/formats';

const live = vi.hoisted(() => ({ formats: [] as FormatDefinition[] }));
vi.mock('../../../src/modules/organiser-exports/formats', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/modules/organiser-exports/formats')>();
  live.formats.push(...real.FORMATS);
  return { ...real, FORMATS: live.formats };
});

import { ORGANISER_EXPORT_PERMISSIONS as X, defineFormat } from '../../../src/modules/organiser-exports';
import { TestApp, makeApp } from '../../support/auth';
import { makeBookingFor, makeCustomer } from '../../support/bookings';
import { closeCatalogue, staffClient } from '../../support/catalogue';
import { walkTo } from '../../support/customer-portal';
import { cleanPayments, paymentsStaff } from '../../support/payments';
import { pricedWorld, type PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let owner: Awaited<ReturnType<typeof staffClient>>;
let a: PricedWorld;
let b: PricedWorld;
let given: string;

async function seedRunner(world: PricedWorld, givenName: string): Promise<void> {
  const customerId = await makeCustomer(t);
  const { bookingId } = await makeBookingFor(t, world, customerId);
  await walkTo(t, bookingId, 'deposit_paid');
  await t.prisma.bookingTraveller.create({ data: { bookingId, customerId, slot: 1, participationType: 'runner_with_entry', raceDistanceId: world.distanceId, isLead: true } });
  await t.prisma.traveller.create({ data: { bookingId, customerId, slot: 1, givenName, familyName: 'Restricted', dateOfBirth: new Date('1990-01-01T00:00:00Z') } });
}

beforeAll(async () => {
  t = await makeApp();
  const admin = await paymentsStaff(t);
  owner = await staffClient(t, [X.read, X.generate]);
  a = await pricedWorld(admin);
  b = await pricedWorld(admin);
  given = 'Orsolyaq';
  await seedRunner(a, given);
  await seedRunner(b, 'Tamsinq');
  live.formats.push(defineFormat({
    id: 'only_race_a', label: 'Race A only', organiser: 'Race A organiser', appliesTo: { raceSlugs: [a.race.slug] }, participation: ['runner_with_entry'],
    file: { delimiter: ',', bom: false, eol: '\r\n' }, columns: [{ header: 'Given name', source: 'givenName', required: true }],
  }));
});
afterAll(async () => {
  await cleanPayments(t);
  await closeCatalogue(t);
});

const body = (world: PricedWorld, formatId: string) => ({ editionId: world.edition.id, formatId });
const ids = async (world: PricedWorld) => ((await owner.get(`/admin/organiser-exports/formats?editionId=${world.edition.id}`)).body.formats as Array<{ id: string }>).map((f) => f.id);

describe('a format restricted to one race, through the API', () => {
  it('is listed for an edition of its race and produces the file there', async () => {
    expect(await ids(a)).toEqual(['entry_list_basic', 'entry_list_international', 'only_race_a']);
    expect((await owner.post('/admin/organiser-exports/check', body(a, 'only_race_a'))).body).toMatchObject({ runners: 1, ready: 1 });
    const res = await owner.post('/admin/organiser-exports', body(a, 'only_race_a'));
    expect(res.status).toBe(200);
    expect(res.text).toBe(`Given name\r\n${given}\r\n`);
  });

  it('on an edition of another race it is not listed, and the check and the file are 404 with the same body as an unknown format', async () => {
    expect(await ids(b)).toEqual(['entry_list_basic', 'entry_list_international']);
    const unknownCheck = await owner.post('/admin/organiser-exports/check', body(b, 'no_such_format'));
    const unknownFile = await owner.post('/admin/organiser-exports', body(b, 'no_such_format'));
    const before = await t.prisma.auditLog.count({ where: { action: 'exports.runnerData.generated', entityId: b.edition.id } });
    const c = await owner.post('/admin/organiser-exports/check', body(b, 'only_race_a'));
    const f = await owner.post('/admin/organiser-exports', body(b, 'only_race_a'));
    for (const [got, unknown] of [[c, unknownCheck], [f, unknownFile]] as const) {
      expect([got.status, got.body.code]).toEqual([404, 'format_not_found']);
      const strip = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'requestId'));
      expect(strip(got.body)).toEqual(strip(unknown.body));
      expect(JSON.stringify(got.body)).not.toContain('only_race_a');
    }
    expect(f.text).not.toContain('Tamsinq');
    expect(await t.prisma.auditLog.count({ where: { action: 'exports.runnerData.generated', entityId: b.edition.id } })).toBe(before);
  });
});
