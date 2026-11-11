import type { Prisma } from '../../generated/prisma/client';
import type { AuditService, AuditSubject } from '../audit/audit.service';

/**
 * A customer's User row is its own personal-data subject (subjectUserId): it exists before its Customer (2.4) and
 * erasure removes both (plan 4.4). Staff users have no subject: their audit values are purged after 7 years.
 */
async function subjectOfUser(tx: Prisma.TransactionClient, userId: string, kind?: unknown): Promise<AuditSubject> {
  const k = kind ?? (await tx.user.findUnique({ where: { id: userId }, select: { kind: true } }))?.kind;
  return k === 'customer' ? { userId } : {};
}

export function registerAuthAuditSubjects(audit: AuditService): void {
  audit.registerSubjectResolver('User', (tx, id, row) => subjectOfUser(tx, id, row.kind));
  audit.registerSubjectResolver('Session', async (tx, id, row) => {
    const userId = typeof row.userId === 'string' ? row.userId : (await tx.session.findUnique({ where: { id }, select: { userId: true } }))?.userId;
    return userId ? subjectOfUser(tx, userId, row.kind) : {};
  });
  audit.registerSubjectResolver('LoginToken', async (tx, id, row) => {
    const userId = typeof row.userId === 'string' ? row.userId : (await tx.loginToken.findUnique({ where: { id }, select: { userId: true } }))?.userId;
    return userId ? subjectOfUser(tx, userId) : {};
  });
}
