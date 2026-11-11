import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { AppError, safeError } from '../errors/safe-error';
import { ApiError } from './api-error';

/**
 * Every error leaves the API as { code, message } with fixed text: no stack, no request values, no database detail
 * (plan 4.1). Validation errors list the paths that failed, never the values.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.describe(err);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json(body);
  }

  private describe(err: unknown): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
    if (err instanceof ApiError) return { status: err.status, body: { code: err.code, message: err.message }, headers: err.headers };
    if (err instanceof ZodError) {
      const fields = [...new Set(err.issues.map((i) => i.path.join('.') || '(body)'))];
      return { status: 422, body: { code: 'validation_failed', message: 'Some fields are not valid', fields }, headers: {} };
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const code = status === 404 ? 'not_found' : status === 405 ? 'method_not_allowed' : status === 413 ? 'payload_too_large' : status < 500 ? 'bad_request' : 'unexpected_error';
      return { status, body: { code, message: status === 404 ? 'Not found' : 'The request could not be processed' }, headers: {} };
    }
    const info = safeError(err);
    if (!(err instanceof AppError)) this.logger.error(`unhandled error: ${info.code}`);
    return { status: 500, body: { code: 'unexpected_error', message: 'An unexpected error occurred' }, headers: {} };
  }
}
