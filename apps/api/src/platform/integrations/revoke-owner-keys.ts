import type { Prisma } from '../../generated/prisma/client';
import type { AuditActor, AuditService } from '../audit/audit.service';

export type OwnerRevokeReason = 'owner_disabled' | 'owner_reset';

/**
 * Revokes every live API key of a staff member in the caller's transaction (task 8.4, C8): when the account is disabled
 * or its credentials are reset. Re-enabling the account never brings the keys back (the database refuses to clear
 * revokedAt). Each revoked key gets its own audit row.
 */
export async function revokeOwnerApiKeys(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  actor: AuditActor,
  ownerUserId: string,
  reason: OwnerRevokeReason,
  now: Date = new Date(),
): Promise<number> {
  const revoked = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE api_keys SET "revokedAt" = ${now}::timestamptz, "revokedById" = ${actor.type === 'staff' ? actor.id : null}::uuid, "revokeReason" = ${reason}
    WHERE "ownerUserId" = ${ownerUserId}::uuid AND "revokedAt" IS NULL
    RETURNING id`;
  for (const { id } of revoked) {
    await audit.record(tx, {
      actor, action: 'integrations.apiKey.revoked', entityType: 'ApiKey', entityId: id,
      before: { revokedAt: null, revokeReason: null }, after: { revokedAt: now, revokeReason: reason },
    });
  }
  return revoked.length;
}
