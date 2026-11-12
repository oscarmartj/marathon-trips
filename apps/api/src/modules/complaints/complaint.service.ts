import { Inject, Injectable } from '@nestjs/common';
import {
  COMPLAINT_OPEN_STATUSES, COMPLAINT_TRANSITIONS, COMPLAINT_DUE_SOON_DAYS,
  type ComplaintQuery, type ComplaintTransition, type CreateComplaint, type UpdateComplaint,
} from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService, type AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { todayInBrisbane } from '../bookings';
import { addDays, defaultDueDates, deadlinesOf } from './deadlines';
import { readDeadlineSettings } from './settings';
import { ComplaintReferences, Tx, assertVersion, fromDate, isUniqueViolation, toDate, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };
type Row = Prisma.ComplaintGetPayload<object>;

const OPEN = [...COMPLAINT_OPEN_STATUSES];
const REFERENCE_ATTEMPTS = 5;

/**
 * The complaints register (task 7.6): a complaint is logged, acknowledged, investigated and resolved against two deadlines.
 * It is never deleted, every change is in the audit log, and nothing here moves money or contacts the complainant.
 */
@Injectable()
export class ComplaintService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ComplaintReferences) private readonly references: ComplaintReferences,
  ) {}

  /** The clock. A method so a test can move it. */
  now(): Date {
    return new Date();
  }

  private present(row: Row, owners: Map<string, string>, today: string) {
    const { receivedDate, acknowledgeDueDate, resolveDueDate, acknowledgedAt, resolvedAt, ...rest } = row;
    const dates = {
      receivedDate: fromDate(receivedDate), acknowledgeDueDate: fromDate(acknowledgeDueDate), resolveDueDate: fromDate(resolveDueDate),
    };
    return view({
      ...rest, ...dates, acknowledgedAt, resolvedAt,
      owner: row.ownerId ? { id: row.ownerId, email: owners.get(row.ownerId) ?? null } : null,
      deadlines: deadlinesOf({
        status: row.status, ...dates,
        acknowledgedOn: acknowledgedAt ? todayInBrisbane(acknowledgedAt) : null,
        resolvedOn: resolvedAt ? todayInBrisbane(resolvedAt) : null,
      }, today),
    });
  }

  private async ownerEmails(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => !!i))];
    if (unique.length === 0) return new Map();
    return new Map((await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
  }

  /** Active staff who can own a complaint. */
  async owners() {
    return { items: await this.prisma.user.findMany({ where: { kind: 'staff', status: 'active' }, select: { id: true, email: true }, orderBy: { email: 'asc' }, take: 200 }) };
  }

  async list(q: ComplaintQuery) {
    const today = todayInBrisbane(this.now());
    const soon = addDays(today, COMPLAINT_DUE_SOON_DAYS);
    const and: Prisma.ComplaintWhereInput[] = [];
    if (q.status === 'open') and.push({ status: { in: OPEN } });
    else if (q.status) and.push({ status: q.status });
    if (q.category) and.push({ category: q.category });
    if (q.ownerId) and.push({ ownerId: q.ownerId });
    if (q.q) and.push({ OR: [{ reference: { contains: q.q, mode: 'insensitive' } }, { complainantName: { contains: q.q, mode: 'insensitive' } }, { summary: { contains: q.q, mode: 'insensitive' } }] });
    if (q.attention === 'acknowledge_overdue') and.push({ status: 'received', acknowledgeDueDate: { lt: toDate(today) } });
    if (q.attention === 'resolve_overdue') and.push({ status: { in: OPEN }, resolveDueDate: { lt: toDate(today) } });
    if (q.attention === 'due_soon') {
      and.push({
        status: { in: OPEN },
        OR: [
          { resolveDueDate: { gte: toDate(today), lte: toDate(soon) } },
          { status: 'received', acknowledgeDueDate: { gte: toDate(today), lte: toDate(soon) } },
        ],
      });
    }
    const where: Prisma.ComplaintWhereInput = and.length ? { AND: and } : {};
    const byDeadline = q.status === 'open' || q.attention !== undefined;
    const orderBy: Prisma.ComplaintOrderByWithRelationInput[] = byDeadline ? [{ resolveDueDate: 'asc' }, { createdAt: 'asc' }] : [{ receivedDate: 'desc' }, { createdAt: 'desc' }];
    const [total, rows] = await Promise.all([
      this.prisma.complaint.count({ where }),
      this.prisma.complaint.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const owners = await this.ownerEmails(rows.map((r) => r.ownerId));
    // The list carries no free text beyond the title: the description, the resolution and the contact address are on the record.
    const items = rows.map((r) => {
      const { description: _d, resolutionSummary: _r, complainantEmail: _e, ...slim } = this.present(r, owners, today);
      return slim;
    });
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Counts for the top of the register. */
  async summary() {
    const today = todayInBrisbane(this.now());
    const soon = addDays(today, COMPLAINT_DUE_SOON_DAYS);
    const [open, acknowledgeOverdue, resolveOverdue, dueSoon, unowned] = await Promise.all([
      this.prisma.complaint.count({ where: { status: { in: OPEN } } }),
      this.prisma.complaint.count({ where: { status: 'received', acknowledgeDueDate: { lt: toDate(today) } } }),
      this.prisma.complaint.count({ where: { status: { in: OPEN }, resolveDueDate: { lt: toDate(today) } } }),
      this.prisma.complaint.count({
        where: { status: { in: OPEN }, OR: [{ resolveDueDate: { gte: toDate(today), lte: toDate(soon) } }, { status: 'received', acknowledgeDueDate: { gte: toDate(today), lte: toDate(soon) } }] },
      }),
      this.prisma.complaint.count({ where: { status: { in: OPEN }, ownerId: null } }),
    ]);
    return { today, open, acknowledgeOverdue, resolveOverdue, dueSoon, unowned };
  }

  async get(id: string) {
    const row = await this.prisma.complaint.findUnique({
      where: { id },
      include: { customer: { select: { id: true, givenName: true, familyName: true, email: true } }, booking: { select: { id: true, reference: true, status: true } } },
    });
    if (!row) throw notFound('complaint_not_found', 'Complaint not found');
    const { customer, booking, ...complaint } = row;
    return { ...this.present(complaint, await this.ownerEmails([row.ownerId]), todayInBrisbane(this.now())), customer, booking };
  }

  private async checkOwner(tx: Tx, ownerId: string | null): Promise<void> {
    if (ownerId && !(await tx.user.findFirst({ where: { id: ownerId, kind: 'staff', status: 'active' }, select: { id: true } }))) {
      throw unprocessable('owner_unknown', 'That person cannot be given the complaint');
    }
  }

  /**
   * Resolves the customer and booking a complaint is about. A booking brings its customer; a customer and booking that do
   * not belong together are refused. Erased customers cannot be linked (their record is no longer theirs).
   */
  private async resolveLinks(tx: Tx, customerId: string | null, bookingId: string | null) {
    let customer: { id: string; givenName: string; familyName: string; email: string } | null = null;
    let resolvedCustomerId = customerId;
    if (bookingId) {
      const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { customerId: true } });
      if (!booking) throw unprocessable('booking_not_found', 'Booking not found');
      if (customerId && booking.customerId !== customerId) throw unprocessable('booking_customer_mismatch', 'That booking belongs to another customer');
      resolvedCustomerId = booking.customerId;
    }
    if (resolvedCustomerId) {
      const found = await tx.customer.findFirst({ where: { id: resolvedCustomerId, deletedAt: null }, select: { id: true, givenName: true, familyName: true, email: true, anonymisedAt: true } });
      if (!found) throw unprocessable('customer_not_found', 'Customer not found');
      if (found.anonymisedAt) throw conflict('customer_erased', 'This customer has been erased and cannot be linked');
      customer = found;
    }
    return { customerId: resolvedCustomerId, customer };
  }

  async create(actor: Actor, input: CreateComplaint) {
    const at = this.now();
    const today = todayInBrisbane(at);
    const receivedDate = input.receivedDate ?? today;
    if (receivedDate > today) throw unprocessable('received_in_future', 'A complaint cannot arrive in the future');
    const defaults = defaultDueDates(receivedDate, await readDeadlineSettings(this.settings));
    const acknowledgeDueDate = input.acknowledgeDueDate ?? defaults.acknowledgeDueDate;
    const resolveDueDate = input.resolveDueDate ?? defaults.resolveDueDate;
    if (!(receivedDate <= acknowledgeDueDate && acknowledgeDueDate <= resolveDueDate)) {
      throw unprocessable('deadlines_out_of_order', 'The deadlines must run in order: received, acknowledge, resolve');
    }
    if ((acknowledgeDueDate !== defaults.acknowledgeDueDate || resolveDueDate !== defaults.resolveDueDate) && !input.reason) {
      throw unprocessable('deadline_reason_required', 'Give a reason for a deadline that is not the usual one');
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          await this.checkOwner(tx, input.ownerId);
          const { customerId, customer } = await this.resolveLinks(tx, input.customerId, input.bookingId);
          const complainantName = input.complainantName ?? (customer ? `${customer.givenName} ${customer.familyName}`.trim() : undefined);
          if (!complainantName) throw unprocessable('complainant_required', 'Say who is complaining');
          const created = await tx.complaint.create({
            data: {
              reference: this.references.next(), customerId, bookingId: input.bookingId, complainantName,
              complainantEmail: input.complainantEmail ?? customer?.email ?? null,
              channel: input.channel, category: input.category, summary: input.summary, description: input.description,
              receivedDate: toDate(receivedDate), acknowledgeDueDate: toDate(acknowledgeDueDate), resolveDueDate: toDate(resolveDueDate),
              ownerId: input.ownerId, createdById: actor.id,
            },
          });
          await this.audit.record(tx, { actor, action: 'complaints.complaint.logged', entityType: 'Complaint', entityId: created.id, reason: input.reason, after: view(created) });
          return created;
        });
        return this.get(row.id);
      } catch (err) {
        if (isUniqueViolation(err, 'reference') && attempt < REFERENCE_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  async update(actor: Actor, id: string, input: UpdateComplaint) {
    const { version, reason, ...changes } = input;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.complaint.findUnique({ where: { id } });
      assertVersion(before, version);
      if (before.status === 'closed' || before.status === 'withdrawn') throw conflict('complaint_final', 'A closed or withdrawn complaint cannot be changed');
      const data: Prisma.ComplaintUncheckedUpdateManyInput = {};
      for (const key of ['complainantName', 'complainantEmail', 'channel', 'category', 'summary', 'description'] as const) {
        if (changes[key] !== undefined) Object.assign(data, { [key]: changes[key] });
      }
      if (changes.ownerId !== undefined) {
        await this.checkOwner(tx, changes.ownerId);
        data.ownerId = changes.ownerId;
      }
      if (changes.customerId !== undefined || changes.bookingId !== undefined) {
        const bookingId = changes.bookingId !== undefined ? changes.bookingId : before.bookingId;
        const customerId = changes.customerId !== undefined ? changes.customerId : before.customerId;
        const links = await this.resolveLinks(tx, customerId, bookingId);
        data.customerId = links.customerId;
        data.bookingId = bookingId;
      }
      const ackDue = changes.acknowledgeDueDate ?? fromDate(before.acknowledgeDueDate);
      const resolveDue = changes.resolveDueDate ?? fromDate(before.resolveDueDate);
      const datesChanged = ackDue !== fromDate(before.acknowledgeDueDate) || resolveDue !== fromDate(before.resolveDueDate);
      if (datesChanged) {
        if (!(fromDate(before.receivedDate) <= ackDue && ackDue <= resolveDue)) throw unprocessable('deadlines_out_of_order', 'The deadlines must run in order: received, acknowledge, resolve');
        if (!reason) throw unprocessable('deadline_reason_required', 'Give a reason for changing a deadline');
        data.acknowledgeDueDate = toDate(ackDue);
        data.resolveDueDate = toDate(resolveDue);
      }
      const res = await tx.complaint.updateMany({ where: { id, version, status: before.status }, data: { ...data, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.complaint.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'complaints.complaint.updated', entityType: 'Complaint', entityId: id, reason, before: view(before), after: view(after) });
    });
    return this.get(id);
  }

  /**
   * One move along COMPLAINT_TRANSITIONS. The first move out of `received` (other than withdrawing) stamps the
   * acknowledgement; resolving needs the outcome and the written resolution; sending a resolved complaint back to
   * `investigating` clears the resolution (the audit log keeps it).
   */
  async transition(actor: Actor, id: string, input: ComplaintTransition) {
    const at = this.now();
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.complaint.findUnique({ where: { id } });
      assertVersion(before, input.version);
      if (!COMPLAINT_TRANSITIONS[before.status].includes(input.status)) throw conflict('transition_not_allowed', 'This status change is not allowed');
      const data: Prisma.ComplaintUncheckedUpdateManyInput = { status: input.status };
      if (input.status !== 'withdrawn' && !before.acknowledgedAt) data.acknowledgedAt = at;
      if (input.status === 'resolved') {
        data.outcome = input.outcome!;
        data.resolutionSummary = input.resolutionSummary!;
        data.resolvedAt = at;
      }
      if (input.status === 'investigating' && before.status === 'resolved') {
        data.outcome = null;
        data.resolutionSummary = null;
        data.resolvedAt = null;
      }
      if (input.status === 'closed') data.closedAt = at;
      if (input.status === 'withdrawn') data.withdrawnAt = at;
      const res = await tx.complaint.updateMany({ where: { id, version: input.version, status: before.status }, data: { ...data, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.complaint.findUniqueOrThrow({ where: { id } });
      const action = before.status === 'resolved' && input.status === 'investigating' ? 'complaints.complaint.reopened' : 'complaints.complaint.status_changed';
      await this.audit.record(tx, {
        actor, action, entityType: 'Complaint', entityId: id, reason: input.reason, before: view(before), after: view(after),
        context: { from: before.status, to: input.status },
      });
    });
    return this.get(id);
  }
}
