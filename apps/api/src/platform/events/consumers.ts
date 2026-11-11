import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../errors/safe-error';

export const PROTECTED_EVENT_PREFIXES = ['payments.', 'bookings.', 'changes.'] as const;
export const DEFAULT_MAX_EVENT_AGE_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface DeliveredEvent {
  id: string;
  type: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number | null;
  payload: unknown;
  actorType: string;
  actorId: string | null;
  occurredAt: Date;
}

export interface ConsumerContext {
  /** The delivery is marked done in this transaction, so the handler's writes and the mark commit together. */
  tx: Prisma.TransactionClient;
}

export interface ConsumerDef {
  /** Unique, stable name. It is part of the delivery key, so renaming a consumer replays old events to it. */
  name: string;
  /** Module whose feature flag gates this consumer (see ALWAYS_ON_MODULES). */
  module: string;
  /** Exact types (`bookings.approved`) or a prefix with a star (`bookings.*`). */
  events: readonly string[];
  /** hold: stay pending until the module is on. skip: mark skipped. */
  whenDisabled: 'hold' | 'skip';
  /** Notice-only consumers (email, outgoing webhook) may drop events that are too old. Others must not. */
  notifyOnly?: boolean;
  maxEventAgeMs?: number;
  maxAttempts?: number;
  handle(event: DeliveredEvent, ctx: ConsumerContext): Promise<void>;
}

const matches = (pattern: string, type: string): boolean =>
  pattern === '*' ? true : pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;

/** Can this pattern match an event whose type starts with the protected prefix (money or booking state)? */
const touchesPrefix = (pattern: string, prefix: string): boolean =>
  pattern === '*' || pattern.startsWith(prefix) || (pattern.endsWith('.*') && prefix.startsWith(pattern.slice(0, -1)));

@Injectable()
export class ConsumerRegistry {
  private readonly consumers = new Map<string, ConsumerDef>();

  register(def: ConsumerDef): void {
    if (this.consumers.has(def.name)) throw new AppError('consumer_duplicate', `Consumer ${def.name} is already registered`);
    if (def.events.length === 0) throw new AppError('consumer_without_events', `Consumer ${def.name} listens to no events`);
    for (const p of def.events) {
      if (!/^(\*|[a-z][a-z_]*(\.[a-z][a-z_]*)*(\.\*)?)$/.test(p)) throw new AppError('consumer_bad_pattern', `Consumer ${def.name} has a bad event pattern`);
    }
    const protectedHit = PROTECTED_EVENT_PREFIXES.some((prefix) => def.events.some((p) => touchesPrefix(p, prefix)));
    if (protectedHit && def.whenDisabled !== 'hold') {
      throw new AppError('consumer_must_hold', `Consumer ${def.name} listens to payments, bookings or changes events, so whenDisabled must be hold`);
    }
    if (def.maxEventAgeMs !== undefined && !def.notifyOnly) {
      throw new AppError('consumer_max_age_not_allowed', `Consumer ${def.name} changes state, so it cannot declare maxEventAgeMs`);
    }
    this.consumers.set(def.name, def);
  }

  get(name: string): ConsumerDef | undefined {
    return this.consumers.get(name);
  }

  all(): ConsumerDef[] {
    return [...this.consumers.values()];
  }

  forEvent(type: string): ConsumerDef[] {
    return this.all().filter((c) => c.events.some((p) => matches(p, type)));
  }
}
