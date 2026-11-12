import { z } from 'zod';
import { isoDateSchema, versionSchema } from './catalogue';

// Request bodies, queries and fixed lists of the complaints register (task 7.6), shared by the API and the panel.
// Strict objects: an unknown field is a 422. No amount appears anywhere: a refund or goodwill payment is not recorded here.

export const COMPLAINT_STATUSES = ['received', 'acknowledged', 'investigating', 'resolved', 'closed', 'withdrawn'] as const;
export const COMPLAINT_CATEGORIES = ['service', 'pricing', 'accommodation', 'transport', 'race_entry', 'communication', 'payment', 'other'] as const;
export const COMPLAINT_CHANNELS = ['email', 'phone', 'web', 'in_person', 'post', 'other'] as const;
export const COMPLAINT_OUTCOMES = ['upheld', 'partly_upheld', 'not_upheld', 'no_finding'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number];
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];

/** Statuses in which the clock is running. */
export const COMPLAINT_OPEN_STATUSES = ['received', 'acknowledged', 'investigating'] as const satisfies readonly ComplaintStatus[];

/** The only moves between statuses. `closed` and `withdrawn` are final; `resolved` can go back to `investigating`. */
export const COMPLAINT_TRANSITIONS: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  received: ['acknowledged', 'investigating', 'resolved', 'withdrawn'],
  acknowledged: ['investigating', 'resolved', 'withdrawn'],
  investigating: ['resolved', 'withdrawn'],
  resolved: ['closed', 'investigating'],
  closed: [],
  withdrawn: [],
};

/** Longest a deadline setting can be, in calendar days. */
export const MAX_COMPLAINT_DEADLINE_DAYS = 90;
/** A deadline "is close" when it falls within this many days. */
export const COMPLAINT_DUE_SOON_DAYS = 3;

const text = (max: number) => z.string().trim().min(1).max(max);
const reason = z.string().trim().min(1).max(500).optional();

const fields = {
  complainantName: text(200),
  complainantEmail: z.email().max(254).nullable(),
  channel: z.enum(COMPLAINT_CHANNELS),
  category: z.enum(COMPLAINT_CATEGORIES),
  summary: text(200),
  description: text(4000),
  ownerId: z.uuid().nullable(),
  customerId: z.uuid().nullable(),
  bookingId: z.uuid().nullable(),
  acknowledgeDueDate: isoDateSchema,
  resolveDueDate: isoDateSchema,
};

/**
 * A complaint is logged on the day it arrived (`receivedDate`, today when left out; never in the future). Both deadlines
 * default to the settings counted from that day; giving one needs a reason, so a changed deadline is explained in the
 * history. The complainant's name and address default to the customer's when a customer is chosen.
 */
export const createComplaintSchema = z.strictObject({
  complainantName: fields.complainantName.optional(),
  complainantEmail: fields.complainantEmail.default(null),
  channel: fields.channel,
  category: fields.category,
  summary: fields.summary,
  description: fields.description,
  ownerId: fields.ownerId.default(null),
  customerId: fields.customerId.default(null),
  bookingId: fields.bookingId.default(null),
  receivedDate: isoDateSchema.optional(),
  acknowledgeDueDate: fields.acknowledgeDueDate.optional(),
  resolveDueDate: fields.resolveDueDate.optional(),
  reason,
});
export type CreateComplaint = z.infer<typeof createComplaintSchema>;

/** The received day is not editable: both deadlines count from it. */
export const updateComplaintSchema = z.strictObject({
  complainantName: fields.complainantName.optional(),
  complainantEmail: fields.complainantEmail.optional(),
  channel: fields.channel.optional(),
  category: fields.category.optional(),
  summary: fields.summary.optional(),
  description: fields.description.optional(),
  ownerId: fields.ownerId.optional(),
  customerId: fields.customerId.optional(),
  bookingId: fields.bookingId.optional(),
  acknowledgeDueDate: fields.acknowledgeDueDate.optional(),
  resolveDueDate: fields.resolveDueDate.optional(),
  version: versionSchema,
  reason,
});
export type UpdateComplaint = z.infer<typeof updateComplaintSchema>;

/**
 * One move to a new status. Resolving needs the outcome and the written resolution; no other move takes them.
 */
export const complaintTransitionSchema = z
  .strictObject({
    status: z.enum(['acknowledged', 'investigating', 'resolved', 'closed', 'withdrawn']),
    outcome: z.enum(COMPLAINT_OUTCOMES).optional(),
    resolutionSummary: text(4000).optional(),
    version: versionSchema,
    reason,
  })
  .superRefine((v, ctx) => {
    const resolving = v.status === 'resolved';
    if (resolving && !v.outcome) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'The outcome is required to resolve a complaint' });
    if (resolving && !v.resolutionSummary) ctx.addIssue({ code: 'custom', path: ['resolutionSummary'], message: 'The resolution is required to resolve a complaint' });
    if (!resolving && (v.outcome || v.resolutionSummary)) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Only resolving a complaint takes an outcome and a resolution' });
  });
export type ComplaintTransition = z.infer<typeof complaintTransitionSchema>;

export const COMPLAINT_ATTENTION = ['acknowledge_overdue', 'resolve_overdue', 'due_soon'] as const;
export type ComplaintAttention = (typeof COMPLAINT_ATTENTION)[number];

export const complaintQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  /** `open` is every status in which the clock is running. */
  status: z.enum(['open', ...COMPLAINT_STATUSES]).optional(),
  attention: z.enum(COMPLAINT_ATTENTION).optional(),
  category: z.enum(COMPLAINT_CATEGORIES).optional(),
  ownerId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ComplaintQuery = z.infer<typeof complaintQuerySchema>;
