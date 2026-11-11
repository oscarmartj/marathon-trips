import { AppError } from '../errors/safe-error';

/** An error with an HTTP status. Code and message are fixed text: never a value from the request or the database. */
export class ApiError extends AppError {
  constructor(
    public readonly status: number,
    code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(code, message);
    this.name = 'ApiError';
  }
}

export const unauthorised = (code = 'unauthenticated', message = 'Sign in to continue') => new ApiError(401, code, message);
export const forbidden = (code = 'forbidden', message = 'You do not have permission to do this') => new ApiError(403, code, message);
export const notFound = (code = 'not_found', message = 'Not found') => new ApiError(404, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const unprocessable = (code: string, message: string) => new ApiError(422, code, message);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new ApiError(429, 'rate_limited', 'Too many attempts. Try again shortly.', { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });
