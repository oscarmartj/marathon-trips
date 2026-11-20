'use client';

import { COMPLAINT_DUE_SOON_DAYS } from '@mt/shared';
import { t } from '@/lib/i18n-admin';
import { badgeClass, type DeadlineStateValue } from '@/lib/complaints-panel';
import { catalogueError, formatDay } from '../catalogue/kit';

export interface Milestone {
  dueDate: string;
  doneOn: string | null;
  state: DeadlineStateValue;
  daysLeft: number | null;
}
export interface Deadlines {
  acknowledge: Milestone;
  resolve: Milestone;
}

export const SOON = COMPLAINT_DUE_SOON_DAYS;

/** A message for a complaints error code: this area's own wording when it has one, else the catalogue's general wording. */
export function complaintError(r: { status: number; body: { code?: string } }): string {
  if (r.status === 403) return t('admin.complaints.errors.forbidden');
  const code = r.body?.code;
  if (code) {
    try {
      return t(`admin.complaints.errors.${code}`);
    } catch {
      /* falls through */
    }
  }
  return catalogueError(r);
}

export function daysText(daysLeft: number): string {
  if (daysLeft === 0) return t('admin.complaints.deadline.dueToday');
  if (daysLeft > 0) return daysLeft === 1 ? t('admin.complaints.deadline.dayLeft') : t('admin.complaints.deadline.daysLeft', { count: daysLeft });
  return daysLeft === -1 ? t('admin.complaints.deadline.dayOver') : t('admin.complaints.deadline.daysOver', { count: -daysLeft });
}

/** One deadline: the date, and in words whether it is met, late, overdue or on track (never colour alone). */
export function DeadlineBadge({ m }: { m: Milestone }) {
  return (
    <span>
      {formatDay(m.dueDate)}{' '}
      <span className={badgeClass(m.state)}>{t(`admin.complaints.deadline.state.${m.state}`)}</span>
      {m.daysLeft !== null && m.state !== 'not_applicable' ? <span className="field__hint"> {daysText(m.daysLeft)}</span> : null}
    </span>
  );
}
