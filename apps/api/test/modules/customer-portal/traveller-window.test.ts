// The edit window of traveller details (task 5.2, plan section 2.4), pure and table-driven.
import { describe, expect, it } from 'vitest';
import { BOOKING_STATUSES } from '@mt/shared';
import type { BookingStatus } from '@mt/shared';
import { DETAILS_OPEN_STATUSES, editWindow, lastEditableDay } from '../../../src/modules/customer-portal';

const facts = (over: Partial<Parameters<typeof editWindow>[0]> = {}) => ({ status: 'confirmed' as BookingStatus, entrySubmissionDate: null, raceStartDate: '2027-06-20', cutoffDays: 14, today: '2027-01-01', ...over });

describe('editWindow', () => {
  it.each(BOOKING_STATUSES.map((s) => [s, DETAILS_OPEN_STATUSES.includes(s)] as const))('status %s: editable %s before the deadline', (status, open) => {
    expect(editWindow(facts({ status }))).toEqual(open
      ? { editable: true, reason: null, editableUntil: '2027-06-06' }
      : { editable: false, reason: 'booking_status', editableUntil: '2027-06-06' });
  });

  it('opens exactly for deposit paid, confirmed and balance paid', () => {
    expect([...DETAILS_OPEN_STATUSES]).toEqual(['deposit_paid', 'confirmed', 'balance_paid']);
  });

  it.each([
    ['the key date wins over the race start rule', { entrySubmissionDate: '2027-03-01' }, '2027-03-01'],
    ['no key date: race start less the cutoff', {}, '2027-06-06'],
    ['a zero cutoff is the race day itself', { cutoffDays: 0 }, '2027-06-20'],
    ['the cutoff crosses a month and a year', { raceStartDate: '2027-01-05', cutoffDays: 14 }, '2026-12-22'],
    ['a leap day', { raceStartDate: '2028-03-05', cutoffDays: 5 }, '2028-02-29'],
    ['neither date: no deadline', { raceStartDate: null }, null],
    ['a key date alone is enough', { raceStartDate: null, entrySubmissionDate: '2027-02-02' }, '2027-02-02'],
  ])('last editable day: %s', (_label, over, expected) => {
    expect(lastEditableDay(facts(over))).toBe(expected);
  });

  it.each([
    ['the day before', '2027-06-05', true], ['the last day itself', '2027-06-06', true], ['the next day', '2027-06-07', false], ['long after', '2027-12-31', false],
  ])('boundary: %s', (_label, today, editable) => {
    expect(editWindow(facts({ today })).editable).toBe(editable);
    expect(editWindow(facts({ today })).reason).toBe(editable ? null : 'deadline_passed');
  });

  it('with no deadline it stays open however late', () => {
    expect(editWindow(facts({ raceStartDate: null, today: '2099-01-01' }))).toEqual({ editable: true, reason: null, editableUntil: null });
  });

  it('a closed status reads as the status even when the deadline has also passed', () => {
    expect(editWindow(facts({ status: 'cancelled', today: '2027-12-31' })).reason).toBe('booking_status');
  });
});
