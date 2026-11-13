import { Inject, Injectable } from '@nestjs/common';
import type { BookingContact } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { conflict } from '../../platform/http/api-error';
import { Tx, jsonOf } from './support';

export interface LockedCustomer {
  id: string;
  version: number;
  givenName: string;
  familyName: string;
  phone: string | null;
  countryOfResidence: string;
  anonymisedAt: Date | null;
  deletedAt: Date | null;
}

const CONTACT_FIELDS = ['givenName', 'familyName', 'phone', 'countryOfResidence'] as const;

/**
 * The customer behind a customer session (plan 2.4, section 4, step 1). Always returned locked FOR UPDATE: the first
 * lock of a request (plan 0.1, 6.3), so two requests of one customer run one after the other. Two first requests at once
 * give one customer: the second INSERT waits for the first and does nothing; a customer without a user and with the
 * verified address is linked once.
 */
@Injectable()
export class CustomerService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  private async lockByUser(tx: Tx, userId: string): Promise<LockedCustomer | null> {
    const rows = await tx.$queryRaw<LockedCustomer[]>`
      SELECT id, version, "givenName", "familyName", phone, "countryOfResidence", "anonymisedAt", "deletedAt"
      FROM customers WHERE "userId" = ${userId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * The customer of a signed-in user, locked FOR UPDATE, without creating one (task 5.5: the privacy routes): the user's
   * own customer, or a customer with the verified address and no user yet (created by staff, task 2.5), which the
   * verified address links, once. Null when there is none. Closed (deleted or anonymised) customers are returned as they
   * are: the caller decides.
   */
  async lockForUser(tx: Tx, user: { id: string; email: string }, actor: AuditActor): Promise<LockedCustomer | null> {
    let customer = await this.lockByUser(tx, user.id);
    if (!customer) {
      const linked = await tx.$executeRaw`
        UPDATE customers SET "userId" = ${user.id}::uuid, "updatedAt" = clock_timestamp(), version = version + 1
        WHERE email = ${user.email}::citext AND "userId" IS NULL AND "deletedAt" IS NULL AND "anonymisedAt" IS NULL`;
      if (linked === 1) {
        customer = await this.lockByUser(tx, user.id);
        await this.audit.record(tx, { actor, action: 'bookings.customer.linked', entityType: 'Customer', entityId: customer!.id, model: 'Customer', before: { userId: null }, after: { userId: user.id } });
      }
    }
    return customer;
  }

  async lockOrCreate(tx: Tx, user: { id: string; email: string }, contact: BookingContact, actor: AuditActor): Promise<{ customer: LockedCustomer; created: boolean }> {
    let customer = await this.lockForUser(tx, user, actor);
    let created = false;
    if (!customer) {
      const inserted = await tx.customer.createMany({
        data: [{ userId: user.id, email: user.email, givenName: contact.givenName, familyName: contact.familyName, phone: contact.phone ?? null, countryOfResidence: contact.countryOfResidence, source: 'web' }],
        skipDuplicates: true,
      });
      customer = await this.lockByUser(tx, user.id);
      if (!customer) throw conflict('customer_conflict', 'This email address belongs to another account');
      if (inserted.count === 1) {
        created = true;
        await this.audit.record(tx, { actor, action: 'bookings.customer.created', entityType: 'Customer', entityId: customer.id, model: 'Customer', after: { ...contactOf(customer), email: user.email } });
      }
    }
    if (customer.deletedAt || customer.anonymisedAt) throw conflict('customer_closed', 'This account is closed');
    return { customer, created };
  }

  /** Applies the contact sent with a request to an existing customer; audited (personal values go to AuditPiiValue). */
  async applyContact(tx: Tx, customer: LockedCustomer, contact: BookingContact, actor: AuditActor): Promise<void> {
    const next = { givenName: contact.givenName, familyName: contact.familyName, phone: contact.phone ?? null, countryOfResidence: contact.countryOfResidence };
    const before = contactOf(customer);
    if (CONTACT_FIELDS.every((f) => before[f] === next[f])) return;
    await tx.customer.update({ where: { id: customer.id }, data: { ...next, version: { increment: 1 } } });
    await this.audit.record(tx, { actor, action: 'bookings.customer.updated', entityType: 'Customer', entityId: customer.id, model: 'Customer', before: jsonOf(before) as Record<string, unknown>, after: next });
  }
}

const contactOf = (c: LockedCustomer) => ({ givenName: c.givenName, familyName: c.familyName, phone: c.phone, countryOfResidence: c.countryOfResidence });
