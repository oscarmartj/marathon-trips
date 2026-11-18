import { AppError } from '../errors/safe-error';

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Task 8.5 (S-11, ASVS 5.0 1.2.x and 4.1.x): the only way the API writes Content-Disposition. The file name is checked
 * against a strict pattern, so a value that came from the database (a slug, a reference) can never break out of the
 * quotes, add a header or carry a path. A name outside the pattern is a programming error, never sent.
 */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  if (!SAFE_FILENAME.test(filename) || filename.includes('..')) throw new AppError('unsafe_filename', 'A download name is not safe');
  return `${kind}; filename="${filename}"`;
}
