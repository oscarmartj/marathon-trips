import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAIM_KINDS, DISTANCE_KINDS, EDITION_STATUSES, EXTRA_KINDS, PARTICIPATION_TYPES, POOL_KINDS, RACE_STATUSES, RACE_TYPES, ROOM_TYPES, SALE_STATUSES } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { t } from '@/lib/i18n';
import { catalogueError } from './kit';

const PARAMS = { count: 1, remaining: 1, capacity: 1, race: 'x', year: 1, page: 1, pages: 1, status: 'x', label: 'x', name: 'x', hotel: 'x', from: 'x', to: 'x', nights: 1, min: 1, max: 1, pool: 'x', type: 'x', unit: 'x', audience: 'x', kind: 'x', distance: 'x', amount: 'x', currency: 'x', city: 'x', country: 'x', value: 'x', state: 'x', date: 'x' };

describe('catalogue panel copy', () => {
  it('every_literal_message_key_used_by_the_panel_exists', () => {
    const dir = __dirname;
    const keys = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\bt\(\s*'(admin\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    }
    for (const f of ['../../../app/admin/(panel)/races/[id]/page.tsx', '../../../app/admin/(panel)/editions/[id]/page.tsx', '../../../app/admin/(panel)/packages/[id]/page.tsx', '../../../app/admin/(panel)/packages/[id]/preview/page.tsx', '../../../app/admin/(panel)/hotels/page.tsx']) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\bt\(\s*'(admin\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(150);
    for (const k of keys) expect(() => t(k, PARAMS), k).not.toThrow();
  });

  it.each([
    ['raceTypes', RACE_TYPES], ['raceStatuses', RACE_STATUSES], ['raceStatusActions', RACE_STATUSES], ['editionStatuses', EDITION_STATUSES], ['editionStatusActions', EDITION_STATUSES],
    ['saleStatuses', SALE_STATUSES], ['saleStatusActions', SALE_STATUSES], ['distanceKinds', DISTANCE_KINDS], ['claimKinds', CLAIM_KINDS], ['participation', PARTICIPATION_TYPES],
    ['poolKinds', POOL_KINDS], ['roomTypes', ROOM_TYPES], ['extraKinds', EXTRA_KINDS], ['pricingUnits', ['per_person', 'per_booking']], ['audiences', ['all', 'runners', 'supporters']],
    ['dateStatuses', ['provisional', 'confirmed']], ['preview.availability', ['available', 'low', 'none']], ['months', Array.from({ length: 12 }, (_, i) => `m${i + 1}`)],
  ])('has_a_label_for_every_%s_value', (group, values) => {
    for (const v of values) expect(() => t(`admin.catalogue.${group}.${v}`, PARAMS), `${group}.${v}`).not.toThrow();
  });

  it('uses_the_catalogue_wording_for_known_error_codes_and_a_general_message_otherwise', () => {
    expect(catalogueError({ status: 409, body: { code: 'duplicate_other_race' } })).toMatch(/same race/);
    expect(catalogueError({ status: 422, body: { code: 'something_new' } })).toBe(t('admin.catalogue.errors.validation_failed'));
    expect(catalogueError({ status: 403, body: {} })).toBe(t('admin.common.forbidden'));
  });

  it('never_mentions_a_price_or_total_computation_in_the_browser', () => {
    const dir = __dirname;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\b(total|subtotal|surcharge)\w*\s*[=+*]/i);
      expect(src, f).not.toMatch(/parseFloat|Number\(.*(amount|price|deposit)/i);
    }
  });
});
