import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../errors/safe-error';

/** Gap-free-within-a-transaction counters, such as booking references. The increment is atomic and runs in the caller's transaction. */
@Injectable()
export class NumberSequenceService {
  async next(tx: Prisma.TransactionClient, key: string): Promise<{ value: bigint; formatted: string }> {
    const rows = await tx.$queryRaw<Array<{ value: bigint; prefix: string }>>`
      UPDATE number_sequences SET "nextValue" = "nextValue" + 1, "updatedAt" = now()
      WHERE key = ${key}
      RETURNING "nextValue" - 1 AS value, prefix`;
    const row = rows[0];
    if (!row) throw new AppError('sequence_unknown', `Number sequence ${key} does not exist`);
    return { value: row.value, formatted: `${row.prefix}${row.value}` };
  }

  async ensure(tx: Prisma.TransactionClient, key: string, prefix = '', start = 1n): Promise<void> {
    await tx.numberSequence.upsert({ where: { key }, create: { key, prefix, nextValue: start }, update: {} });
  }
}
