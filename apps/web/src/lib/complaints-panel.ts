import { COMPLAINT_TRANSITIONS, type ComplaintAttention, type ComplaintCategory, type ComplaintStatus } from '@mt/shared';

/**
 * The complaints register's rules as plain functions, so they can be tested without a browser. The API checks everything
 * again; this only shapes what is sent and what is shown. Nothing here works out a deadline: dates come from the API.
 */
export type DeadlineStateValue = 'met' | 'late' | 'overdue' | 'due_soon' | 'pending' | 'not_applicable';

export interface ListFilters {
  q: string;
  status: '' | 'open' | ComplaintStatus;
  attention: '' | ComplaintAttention;
  category: '' | ComplaintCategory;
  page: number;
}
export const emptyFilters: ListFilters = { q: '', status: 'open', attention: '', category: '', page: 1 };

/** The query string of the list route: only what is set, and a search term only from two letters. */
export function listParams(f: ListFilters, pageSize = 25): string {
  const p = new URLSearchParams({ page: String(f.page), pageSize: String(pageSize) });
  if (f.q.trim().length >= 2) p.set('q', f.q.trim());
  if (f.status) p.set('status', f.status);
  if (f.attention) p.set('attention', f.attention);
  if (f.category) p.set('category', f.category);
  return p.toString();
}

/** Where a complaint can go next. Reopening is a move from resolved back to investigating. */
export function nextStatuses(status: ComplaintStatus): ComplaintStatus[] {
  return [...COMPLAINT_TRANSITIONS[status]];
}
export const isReopen = (from: ComplaintStatus, to: ComplaintStatus): boolean => from === 'resolved' && to === 'investigating';

export interface TransitionForm {
  outcome: string;
  resolutionSummary: string;
  reason: string;
}

/** The body of a status move: the outcome and the resolution go only with `resolved`. */
export function transitionBody(status: ComplaintStatus, version: number, form: TransitionForm): Record<string, unknown> {
  const body: Record<string, unknown> = { status, version };
  if (status === 'resolved') {
    body.outcome = form.outcome;
    body.resolutionSummary = form.resolutionSummary.trim();
  }
  if (form.reason.trim()) body.reason = form.reason.trim();
  return body;
}

/** A deadline needs attention when it is overdue, or close and not done. Colour is never the only signal: the badge says it too. */
export const needsAttention = (state: DeadlineStateValue): boolean => state === 'overdue' || state === 'due_soon';
export const badgeClass = (state: DeadlineStateValue): string => (state === 'overdue' || state === 'late' ? 'badge badge--warn' : 'badge');

export interface CreateForm {
  complainantName: string;
  complainantEmail: string;
  channel: string;
  category: string;
  summary: string;
  description: string;
  receivedDate: string;
  customerId: string;
  bookingId: string;
  ownerId: string;
  reason: string;
}

/** The body of a new complaint. Empty optional fields are left out so the API fills in its defaults. */
export function createBody(f: CreateForm): Record<string, unknown> {
  const body: Record<string, unknown> = { channel: f.channel, category: f.category, summary: f.summary.trim(), description: f.description.trim() };
  const optional: Array<[string, string]> = [
    ['complainantName', f.complainantName], ['complainantEmail', f.complainantEmail], ['receivedDate', f.receivedDate], ['customerId', f.customerId], ['bookingId', f.bookingId], ['ownerId', f.ownerId], ['reason', f.reason],
  ];
  for (const [k, v] of optional) if (v.trim()) body[k] = v.trim();
  return body;
}
