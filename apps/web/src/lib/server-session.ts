import { cookies } from 'next/headers';
import { apiBase } from './api-proxy';

export interface StaffSession {
  userId: string;
  email: string;
  isOwner: boolean;
  permissions: string[];
  stepUpValidUntil: string | null;
}

/**
 * The staff session for the panel layout. Only for showing or redirecting: every API route checks the session and
 * permissions itself, whatever the page shows.
 */
export async function getStaffSession(): Promise<StaffSession | null> {
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${apiBase()}/auth/staff/session`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as StaffSession) : null;
  } catch {
    return null;
  }
}
