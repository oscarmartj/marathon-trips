import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getStaffSession } from '@/lib/server-session';

// Every panel page needs a staff session; without one the browser goes to staff sign-in. This only shapes the
// pages: the API refuses every admin call without a session and the right permission, whatever is shown here.
export default async function PanelLayout({ children }: { children: ReactNode }) {
  if (!(await getStaffSession())) redirect('/admin/sign-in');
  return children;
}
