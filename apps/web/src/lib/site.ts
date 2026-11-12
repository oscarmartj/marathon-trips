/** The public address of the site (no trailing slash). WEB_ORIGIN is the same variable the API uses for its one accepted origin. */
export function siteUrl(): string {
  const raw = process.env.WEB_ORIGIN?.trim() || 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

/** An absolute URL on this site for a path such as `/races/sample`. */
export const absoluteUrl = (path: string): string => `${siteUrl()}${path}`;
