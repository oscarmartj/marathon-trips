import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPLAINT_ATTENTION, COMPLAINT_CATEGORIES, COMPLAINT_CHANNELS, COMPLAINT_OUTCOMES, COMPLAINT_STATUSES, COMPLAINT_TRANSITIONS } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { t } from '@/lib/i18n';
import { catalogueError } from '../catalogue/kit';
import { complaintError, daysText } from './complaints-kit';

const PARAMS = { days: 3, count: 2, date: 'x', when: 'x', what: 'x', reason: 'x', status: 'x' };

describe('complaints panel copy', () => {
  it('every literal message key used by the complaints panel exists', () => {
    const keys = new Set<string>();
    const files = [
      ...readdirSync(__dirname).filter((f) => f.endsWith('.tsx')).map((f) => join(__dirname, f)),
      join(__dirname, '../../../app/admin/(panel)/complaints/page.tsx'),
      join(__dirname, '../../../app/admin/(panel)/complaints/[id]/page.tsx'),
    ];
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'(admin\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThan(40);
    for (const k of keys) expect(() => t(k, PARAMS), k).not.toThrow();
  });

  it.each([
    ['statuses', COMPLAINT_STATUSES], ['categories', COMPLAINT_CATEGORIES], ['channels', COMPLAINT_CHANNELS], ['outcomes', COMPLAINT_OUTCOMES],
    ['filters.attentionValues', COMPLAINT_ATTENTION], ['deadline.state', ['met', 'late', 'overdue', 'due_soon', 'pending', 'not_applicable']],
  ])('has a label for every %s value', (group, values) => {
    for (const v of values) expect(() => t(`admin.complaints.${group}.${v}`, PARAMS), `${group}.${v}`).not.toThrow();
  });

  it('has a button label for every status a complaint can be moved to', () => {
    const targets = new Set(Object.values(COMPLAINT_TRANSITIONS).flat());
    for (const s of targets) expect(() => t(`admin.complaints.status.to.${s}`), s).not.toThrow();
  });

  it('has wording for every complaints error code the API can return', () => {
    const codes = [
      'complainant_required', 'received_in_future', 'owner_unknown', 'customer_not_found', 'booking_not_found', 'booking_customer_mismatch', 'customer_erased',
      'deadline_reason_required', 'deadlines_out_of_order', 'complaint_final', 'transition_not_allowed', 'complaint_not_found', 'version_conflict',
    ];
    for (const code of codes) expect(complaintError({ status: 409, body: { code } }), code).toBe(t(`admin.complaints.errors.${code}`));
    expect(complaintError({ status: 403, body: { code: 'forbidden' } })).toBe('You do not have permission to do this.');
    expect(complaintError({ status: 500, body: {} })).toBe(catalogueError({ status: 500, body: {} }));
  });

  it('has wording for every history action it recognises', () => {
    for (const k of ['logged', 'updated', 'status_changed', 'reopened', 'note_added', 'note_edited', 'note_deleted']) expect(() => t(`admin.complaints.history.actions.${k}`), k).not.toThrow();
  });

  it('says days left and days over in words', () => {
    expect(daysText(0)).toBe('Due today');
    expect(daysText(1)).toBe('1 day left');
    expect(daysText(5)).toBe('5 days left');
    expect(daysText(-1)).toBe('1 day overdue');
    expect(daysText(-4)).toBe('4 days overdue');
  });

  it('never works out a deadline in the browser: dates come from the API', () => {
    const src = readdirSync(__dirname).filter((f) => f.endsWith('.tsx')).map((f) => readFileSync(join(__dirname, f), 'utf8')).join('\n');
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)|setDate\(|getTime\(\)|86_?400/);
  });
});
