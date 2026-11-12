import { COMPLAINT_STATUSES } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { badgeClass, createBody, emptyFilters, isReopen, listParams, needsAttention, nextStatuses, transitionBody } from './complaints-panel';

describe('complaints panel rules', () => {
  it('lists open complaints first and sends only what is set', () => {
    expect(listParams(emptyFilters)).toBe('page=1&pageSize=25&status=open');
    expect(listParams({ ...emptyFilters, status: '', q: ' a ', attention: 'resolve_overdue', category: 'pricing', page: 3 })).toBe('page=3&pageSize=25&attention=resolve_overdue&category=pricing');
    expect(listParams({ ...emptyFilters, q: ' Pat ' })).toContain('q=Pat');
  });

  it('offers the moves the API allows and nothing from a final status', () => {
    expect(nextStatuses('received')).toEqual(['acknowledged', 'investigating', 'resolved', 'withdrawn']);
    expect(nextStatuses('resolved')).toEqual(['closed', 'investigating']);
    expect(nextStatuses('closed')).toEqual([]);
    expect(nextStatuses('withdrawn')).toEqual([]);
    expect(COMPLAINT_STATUSES.every((s) => Array.isArray(nextStatuses(s)))).toBe(true);
    expect(isReopen('resolved', 'investigating')).toBe(true);
    expect(isReopen('received', 'investigating')).toBe(false);
  });

  it('puts the outcome and resolution on a resolve only', () => {
    const form = { outcome: 'upheld', resolutionSummary: '  We apologised.  ', reason: ' ' };
    expect(transitionBody('resolved', 4, form)).toEqual({ status: 'resolved', version: 4, outcome: 'upheld', resolutionSummary: 'We apologised.' });
    expect(transitionBody('closed', 5, { ...form, reason: 'Done' })).toEqual({ status: 'closed', version: 5, reason: 'Done' });
  });

  it('marks overdue and close deadlines, and says late ones in the badge too', () => {
    expect(needsAttention('overdue')).toBe(true);
    expect(needsAttention('due_soon')).toBe(true);
    expect(needsAttention('met')).toBe(false);
    expect(badgeClass('late')).toContain('warn');
    expect(badgeClass('met')).toBe('badge');
  });

  it('leaves empty optional fields out of a new complaint', () => {
    const body = createBody({ complainantName: ' Pat ', complainantEmail: '', channel: 'phone', category: 'service', summary: ' Late bus ', description: ' It was late. ', receivedDate: '', customerId: '', bookingId: '', ownerId: '', reason: '' });
    expect(body).toEqual({ channel: 'phone', category: 'service', summary: 'Late bus', description: 'It was late.', complainantName: 'Pat' });
  });
});
