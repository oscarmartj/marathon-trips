import type { ReactNode } from 'react';
import { Logo } from './logo';
import { NavLinks } from './nav-links';
import { SignOutButton } from './admin/sign-out-button';
import { GlobalSearch } from './admin/global-search';
import { adminRoutes } from '@/lib/routes';
import { t } from '@/lib/i18n';

/**
 * Admin page frame: sidebar plus the page's single h1. Each admin page passes its own path so the
 * current page is marked without client JavaScript. The (panel) layout redirects to sign-in without a staff session;
 * the API checks permissions on every call whatever the page shows.
 */
export function AdminPage({ current, title, intro, placeholder = true, children }: { current: string; title: string; intro: string; placeholder?: boolean; children?: ReactNode }) {
  return (
    <div className="admin">
      <aside className="admin__side on-night">
        <Logo />
        <nav aria-label={t('admin.nav.label')}>
          <NavLinks routes={adminRoutes.filter((r) => r.nav)} current={current} />
        </nav>
        <GlobalSearch />
        <SignOutButton />
      </aside>
      <main id="main" className="admin__main stack">
        <h1>{title}</h1>
        <p>{intro}</p>
        {placeholder ? <p className="notice" role="note">{t('admin.placeholder')}</p> : null}
        {children}
      </main>
    </div>
  );
}
