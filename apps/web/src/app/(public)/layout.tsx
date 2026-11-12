import type { ReactNode } from 'react';
import { Banners } from '@/components/banners';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';

// Header, footer and banners read the content manager. The reads are cached for a minute, so a change staff publish
// reaches every page within about a minute without a deploy.
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Banners />
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
