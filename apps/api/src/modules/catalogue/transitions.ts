import type { EditionStatus, RaceStatus, SaleStatus } from '@mt/shared';

// Transition tables (plan 0.1, section 6.1). A test walks every (from, to) pair and only these pass.

export const SALE_TRANSITIONS: Readonly<Record<SaleStatus, readonly SaleStatus[]>> = {
  draft: ['coming_soon', 'open'],
  coming_soon: ['open', 'closed', 'draft'],
  open: ['waitlist', 'sold_out', 'closed'],
  waitlist: ['open', 'closed'],
  sold_out: ['open', 'waitlist', 'closed'],
  closed: ['open'],
};

export const RACE_TRANSITIONS: Readonly<Record<RaceStatus, readonly RaceStatus[]>> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft'],
};

export const EDITION_TRANSITIONS: Readonly<Record<EditionStatus, readonly EditionStatus[]>> = {
  draft: ['announced', 'cancelled'],
  announced: ['draft', 'active', 'cancelled', 'completed'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['draft'],
};

export const canMove = <S extends string>(table: Readonly<Record<S, readonly S[]>>, from: S, to: S): boolean => table[from].includes(to);

/** Statuses a package must have been through before the public website may show it. */
export const PUBLIC_SALE_STATUSES: readonly SaleStatus[] = ['coming_soon', 'open', 'waitlist', 'sold_out', 'closed'];
/** Statuses in which a package is on sale or waiting for stock; its deposit can no longer be cleared. */
export const LIVE_SALE_STATUSES: readonly SaleStatus[] = ['open', 'waitlist', 'sold_out'];
