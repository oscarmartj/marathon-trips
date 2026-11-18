import type { Prisma } from '../../generated/prisma/client';
import type { CustomerLink, EntityDef, EntityRegistry } from '../entities/entity-registry';

type Tx = Prisma.TransactionClient;

export const ERASED_TEXT = '[redacted]';

/** The address an erased row gets when its column must stay a unique, valid-looking address (plan 0.1, 4.9). */
export const erasedAddress = (id: string): string => `erased+${id}@invalid`;

/**
 * Tables that point at any record by (entityType, entityId) without a relation (plan 0.1, 4.9), and what erasure does
 * to the rows on a customer's records. A test fails if a model with those two columns is missing here.
 */
export const POLYMORPHIC_TABLES = {
  Note: 'redact', // body is staff free text
  Task: 'redact', // title and description are staff free text
  SearchDocument: 'delete', // rebuilt from data; titles can hold names
  Tagging: 'keep', // a tag link holds no text (tag names are not about a person)
  AuditLog: 'keep', // append-only, no personal values (those are in AuditPiiValue, erased by privacy_erase_customer)
  AutomationRun: 'keep', // steps hold codes only
} as const;

/**
 * Tables with customer data that the privacy executor handles itself, because they are reached by user or by address,
 * not through the entity registry. A test fails if a customer table is neither registered nor here.
 */
export const EXECUTOR_TABLES = {
  User: 'anonymise the customer user',
  Session: 'delete',
  LoginToken: 'delete',
  OutboundEmail: 'redact the address and subject; never send a queued one',
  PrivacyRequest: 'kept: proof of the request, no personal data',
  ConsentRecord: 'kept: proof of consent, address hash only; customerId cleared by privacy_erase_customer',
} as const;

/**
 * Registered entities whose rows can belong to someone by address alone (no customer id): a sign-in account with no
 * customer record (plan 5.5, section 2.1; review m6) is exported and erased through these, with a nil customer id.
 */
export const ADDRESS_LINKED_ENTITIES: readonly string[] = ['AlertSubscription', 'Complaint'];
export const NO_CUSTOMER = '00000000-0000-0000-0000-000000000000';

const delegateOf = (tx: Tx, model: string) =>
  (tx as unknown as Record<string, { findMany: (a: unknown) => Promise<Array<{ id: string }>> }>)[model.charAt(0).toLowerCase() + model.slice(1)];

/**
 * The ids of every registered record of this customer, by entity type, found by walking each entity's customerLink
 * (plan 0.1, 4.9: "the erasure list comes from the registry, not from a hand-written table"). Plain reads.
 */
export async function customerRecordIds(tx: Tx, registry: EntityRegistry, customerId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const resolve = async (def: EntityDef, seen: Set<string>): Promise<string[]> => {
    const known = out.get(def.entityType);
    if (known) return known;
    const link = def.customerLink as CustomerLink;
    let ids: string[] = [];
    if (link.kind === 'self') ids = [customerId];
    else {
      let where: Record<string, unknown>;
      if (link.kind === 'column') where = { [link.column]: customerId };
      else {
        const parent = registry.get(link.entityType);
        if (!parent?.customerLink || seen.has(parent.entityType)) return [];
        const parentIds = await resolve(parent, new Set([...seen, def.entityType]));
        where = { [link.column]: { in: parentIds } };
        if (parentIds.length === 0) {
          out.set(def.entityType, []);
          return [];
        }
      }
      const delegate = delegateOf(tx, def.model);
      ids = delegate ? (await delegate.findMany({ where, select: { id: true } })).map((r) => r.id) : [];
    }
    out.set(def.entityType, ids);
    return ids;
  };
  for (const def of registry.withCustomerLink()) await resolve(def, new Set([def.entityType]));
  return out;
}

/** Notes, tasks and search documents on the customer's records (and the search documents of those tasks). */
export async function erasePolymorphic(tx: Tx, records: Map<string, string[]>): Promise<void> {
  for (const [entityType, ids] of records) {
    if (ids.length === 0) continue;
    await tx.note.updateMany({ where: { entityType, entityId: { in: ids }, body: { not: ERASED_TEXT } }, data: { body: ERASED_TEXT } });
    const tasks = (await tx.task.findMany({ where: { entityType, entityId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    if (tasks.length > 0) {
      await tx.task.updateMany({ where: { id: { in: tasks } }, data: { title: ERASED_TEXT } });
      await tx.task.updateMany({ where: { id: { in: tasks }, description: { not: null } }, data: { description: ERASED_TEXT } });
      await tx.searchDocument.deleteMany({ where: { entityType: 'Task', entityId: { in: tasks } } });
    }
    await tx.searchDocument.deleteMany({ where: { entityType, entityId: { in: ids } } });
  }
}

/** Staff notes and tasks on the customer's records, for the owner's `full` export only. */
export async function staffNotesOf(tx: Tx, records: Map<string, string[]>) {
  const out: Array<Record<string, unknown>> = [];
  for (const [entityType, ids] of records) {
    if (ids.length === 0) continue;
    for (const n of await tx.note.findMany({ where: { entityType, entityId: { in: ids } }, select: { entityId: true, body: true, createdAt: true, deletedAt: true }, orderBy: { createdAt: 'asc' } })) {
      out.push({ kind: 'note', on: entityType, entityId: n.entityId, text: n.body, createdAt: n.createdAt, deleted: n.deletedAt !== null });
    }
    for (const k of await tx.task.findMany({ where: { entityType, entityId: { in: ids } }, select: { entityId: true, title: true, description: true, status: true, createdAt: true }, orderBy: { createdAt: 'asc' } })) {
      out.push({ kind: 'task', on: entityType, entityId: k.entityId, text: [k.title, k.description].filter(Boolean).join('\n'), status: k.status, createdAt: k.createdAt });
    }
  }
  return out;
}

/**
 * The executor's own tables (EXECUTOR_TABLES): the customer user, its sessions and sign-in links, and every email to the
 * customer or to any of its addresses. A queued email is marked suppressed so it is never sent; the send step locks the
 * row and only sends queued ones (it also refuses one whose customer is anonymised).
 */
export async function erasePlatformRows(tx: Tx, who: { customerId: string | null; userId: string | null; emails: readonly string[] }): Promise<void> {
  const emails = [...who.emails];
  if (who.userId) {
    await tx.$executeRaw`
      UPDATE users SET email = ${erasedAddress(who.userId)}, status = 'disabled', "anonymisedAt" = COALESCE("anonymisedAt", clock_timestamp()),
             version = version + 1, "updatedAt" = clock_timestamp()
       WHERE id = ${who.userId}::uuid AND kind = 'customer'`;
    await tx.session.deleteMany({ where: { userId: who.userId } });
  }
  await tx.$executeRaw`DELETE FROM login_tokens WHERE ("userId" = ${who.userId}::uuid) OR lower(email::text) = ANY(${emails}::text[])`;
  await tx.$executeRaw`
    UPDATE outbound_emails
       SET "to" = 'erased+' || id::text || '@invalid',
           subject = CASE WHEN subject = '' THEN '' ELSE ${ERASED_TEXT} END,
           error = CASE WHEN status = 'queued' THEN 'recipient_erased' ELSE NULL END,
           status = CASE WHEN status = 'queued' THEN 'suppressed'::"OutboundEmailStatus" ELSE status END,
           "updatedAt" = clock_timestamp()
     WHERE ("customerId" = ${who.customerId}::uuid OR lower("to") = ANY(${emails}::text[]))
       AND "to" NOT LIKE 'erased+%@invalid'`;
}

/** What the export says about the sign-in account, the emails sent and the sign-ins (the executor's own tables). */
export async function platformExport(tx: Tx, who: { customerId: string | null; userId: string | null; emails: readonly string[] }) {
  const user = who.userId ? await tx.user.findUnique({ where: { id: who.userId }, select: { email: true, createdAt: true, lastLoginAt: true } }) : null;
  const emails = await tx.$queryRaw<Array<{ subject: string; category: string; status: string; sentAt: Date | null; createdAt: Date }>>`
    SELECT subject, category::text AS category, status::text AS status, "sentAt", "createdAt" FROM outbound_emails
     WHERE "customerId" = ${who.customerId}::uuid OR lower("to") = ANY(${[...who.emails]}::text[])
     ORDER BY "createdAt"`;
  const signIns = who.userId
    ? await tx.session.findMany({ where: { userId: who.userId }, select: { createdAt: true, lastSeenAt: true, userAgent: true }, orderBy: { createdAt: 'asc' } })
    : [];
  return { account: user, emails, signIns };
}
