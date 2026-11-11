import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../errors/safe-error';
import { assertIdentifiersOnly } from '../guards/no-personal-data';

export interface EventInput {
  /** Lower-case dotted name, module first: bookings.approved. */
  type: string;
  schemaVersion?: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  /** Identifiers only. */
  payload?: Record<string, unknown>;
  actorType: 'staff' | 'customer' | 'system' | 'automation' | 'api_key';
  actorId?: string;
}

const TYPE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

@Injectable()
export class OutboxService {
  /**
   * Writes the event in the caller's transaction (plan 4.5): if that transaction rolls back, so does the event.
   * Pass the `tx` of `prisma.$transaction`; there is deliberately no way to publish without one.
   */
  async publish(tx: Prisma.TransactionClient, input: EventInput): Promise<string> {
    if (!TYPE.test(input.type)) throw new AppError('event_bad_type', 'Event type must be lower-case dotted, such as bookings.approved');
    const payload = input.payload ?? {};
    assertIdentifiersOnly('event payload', payload);
    const row = await tx.outboxEvent.create({
      data: {
        type: input.type,
        schemaVersion: input.schemaVersion ?? 1,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        aggregateVersion: input.aggregateVersion ?? null,
        payload: payload as Prisma.InputJsonObject,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }
}
