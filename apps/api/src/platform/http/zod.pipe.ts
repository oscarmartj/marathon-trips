import { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates and strips a body or query with a shared zod schema; failures become 422 in ApiErrorFilter. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value ?? {});
  }
}
