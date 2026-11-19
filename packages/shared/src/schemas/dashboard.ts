// The staff start page (task 5.6). Types only: the page is read-only, and each section is present only when the caller holds
// the permission that reads what it shows. Money is a string of digits in minor units with its currency, as the API
// states it; dates are YYYY-MM-DD or ISO instants.

export const DASHBOARD_PERMISSIONS = {
  newRequests: 'bookings.booking.read',
  pendingPayments: 'payments.payment.read',
  stock: 'catalogue.package.read',
  subscribers: 'alerts.subscription.read',
  tasks: 'common.task.read',
} as const;

export type DashboardSectionKey = keyof typeof DASHBOARD_PERMISSIONS;

export interface DashboardNewRequest {
  id: string;
  reference: string;
  requestedAt: string;
  requestExpiresAt: string;
  raceName: string;
  year: number;
  packageName: string;
}

export interface DashboardPendingPayment {
  bookingId: string;
  reference: string;
  kind: 'deposit' | 'balance' | 'instalment' | 'adjustment' | 'penalty';
  sequence: number;
  dueDate: string;
  amountDueMinor: string;
  currency: string;
  overdue: boolean;
}

export interface DashboardStockPool {
  id: string;
  kind: 'entry' | 'room' | 'extra';
  label: string;
  capacity: number;
  remaining: number;
  lowStock: boolean;
  editionId: string;
  year: number;
  raceName: string;
}

export interface DashboardRaceSubscribers {
  raceId: string;
  slug: string;
  raceName: string;
  confirmed: number;
  pending: number;
}

export interface DashboardTask {
  id: string;
  title: string;
  dueAt: string;
  overdue: boolean;
}

export interface DashboardView {
  /** Today in Brisbane. */
  today: string;
  generatedAt: string;
  sections: {
    newRequests?: { total: number; items: DashboardNewRequest[] };
    pendingPayments?: { overdue: number; dueSoon: number; horizonDays: number; truncated: boolean; items: DashboardPendingPayment[] };
    stock?: { lowCount: number; items: DashboardStockPool[] };
    subscribers?: { confirmed: number; pending: number; races: DashboardRaceSubscribers[] };
    tasks?: { overdue: number; dueSoon: number; items: DashboardTask[] };
  };
}

/** How many rows each list on the page shows. */
export const DASHBOARD_LIST_SIZE = 8;
/** Open tasks due within this many days count as "due soon". */
export const DASHBOARD_TASK_DAYS = 7;
