// Deadline arithmetic of the complaints register (task 7.6): table-driven, pure.
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, deadlinesOf, defaultDueDates, milestone } from '../../../src/modules/complaints/deadlines';

describe('calendar arithmetic', () => {
  it.each([
    ['2027-01-30', 2, '2027-02-01'],
    ['2027-12-31', 1, '2028-01-01'],
    ['2028-02-28', 1, '2028-02-29'], // leap year
    ['2027-02-28', 1, '2027-03-01'],
    ['2027-03-10', 30, '2027-04-09'],
    ['2027-03-10', 0, '2027-03-10'],
  ])('addDays(%s, %i) = %s', (from, n, expected) => {
    expect(addDays(from, n)).toBe(expected);
  });

  it.each([
    ['2027-03-10', '2027-03-10', 0],
    ['2027-03-10', '2027-03-13', 3],
    ['2027-03-13', '2027-03-10', -3],
    ['2027-12-30', '2028-01-02', 3],
  ])('daysBetween(%s, %s) = %i', (a, b, n) => {
    expect(daysBetween(a, b)).toBe(n);
  });
});

describe('default due dates', () => {
  it('count calendar days from the day it arrived', () => {
    expect(defaultDueDates('2027-03-10', { acknowledgeDays: 2, resolveDays: 30 })).toEqual({ acknowledgeDueDate: '2027-03-12', resolveDueDate: '2027-04-09' });
  });
  it('never put acknowledging after resolving, even if the settings are the wrong way round', () => {
    expect(defaultDueDates('2027-03-10', { acknowledgeDays: 20, resolveDays: 5 })).toEqual({ acknowledgeDueDate: '2027-03-15', resolveDueDate: '2027-03-15' });
  });
});

describe('milestone state at the boundaries', () => {
  const due = '2027-03-12';
  // [today, doneOn, applicable, state, daysLeft]
  it.each([
    ['2027-03-05', null, true, 'pending', 7],
    ['2027-03-09', null, true, 'due_soon', 3], // exactly COMPLAINT_DUE_SOON_DAYS before
    ['2027-03-08', null, true, 'pending', 4], // one day too early to be "soon"
    ['2027-03-12', null, true, 'due_soon', 0], // the due date itself is still on time
    ['2027-03-13', null, true, 'overdue', -1], // the first late day
    ['2027-03-20', null, true, 'overdue', -8],
    ['2027-03-20', '2027-03-11', true, 'met', null],
    ['2027-03-20', '2027-03-12', true, 'met', null], // done on the due date is on time
    ['2027-03-20', '2027-03-13', true, 'late', null],
    ['2027-03-20', null, false, 'not_applicable', null],
  ] as const)('today %s, done %s, applicable %s is %s', (today, doneOn, applicable, state, daysLeft) => {
    expect(milestone(due, doneOn, today, applicable)).toEqual({ dueDate: due, doneOn, state, daysLeft });
  });
});

describe('deadlinesOf for each status', () => {
  const base = { acknowledgeDueDate: '2027-03-12', resolveDueDate: '2027-04-09', acknowledgedOn: null, resolvedOn: null };
  it('a new complaint owes both steps', () => {
    const d = deadlinesOf({ ...base, status: 'received' }, '2027-03-13');
    expect(d.acknowledge.state).toBe('overdue');
    expect(d.resolve.state).toBe('pending');
  });
  it('acknowledged late stays "late" for the record', () => {
    const d = deadlinesOf({ ...base, status: 'investigating', acknowledgedOn: '2027-03-14' }, '2027-03-20');
    expect(d.acknowledge.state).toBe('late');
  });
  it('resolved on the last day is met', () => {
    const d = deadlinesOf({ ...base, status: 'resolved', acknowledgedOn: '2027-03-11', resolvedOn: '2027-04-09' }, '2027-06-01');
    expect(d.acknowledge.state).toBe('met');
    expect(d.resolve.state).toBe('met');
  });
  it('withdrawn before anyone answered owes nothing', () => {
    const d = deadlinesOf({ ...base, status: 'withdrawn' }, '2027-06-01');
    expect(d.acknowledge.state).toBe('not_applicable');
    expect(d.resolve.state).toBe('not_applicable');
  });
  it('withdrawn after it was acknowledged keeps the acknowledgement result but owes no resolution', () => {
    const d = deadlinesOf({ ...base, status: 'withdrawn', acknowledgedOn: '2027-03-12' }, '2027-06-01');
    expect(d.acknowledge.state).toBe('met');
    expect(d.resolve.state).toBe('not_applicable');
  });
});
