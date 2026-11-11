import type { ReactNode } from 'react';
import type { Metadata } from 'next';

// The admin area is never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
