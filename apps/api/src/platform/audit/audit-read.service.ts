import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/** History of a record (plan 4.4): `changes` only; personal values in AuditPiiValue are never returned here. */
@Injectable()
export class AuditReadService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async history(entityType: string, entityId: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      select: { id: true, occurredAt: true, actorType: true, actorId: true, action: true, changes: true },
    });
    return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
  }
}
