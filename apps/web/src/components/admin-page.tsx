import type { ReactNode } from 'react';
import { Logo } from './logo';
import { NavLinks } from './nav-links';
import { adminRoutes } from '@/lib/routes';
import { t } from '@/lib/i18n';

/**
 * Admin page frame: sidebar plus the page's single h1. Each admin page passes its own path so the
 * current page is marked without client JavaScript. Sign-in and permissions arrive with authentication.
 */
export function AdminPage({ current, title, intro, children }: { current: string; title: string; intro: string; children?: ReactNode }) {
  return (
    <div className="admin">
      <aside className="admin__side on-night">
        <Logo />
        <nav aria-label={t('admin.nav.label')}>
          <NavLinks routes={adminRoutes} current={current} />
        </nav>
      </aside>
      <main id="main" className="admin__main stack">
        <h1>{title}</h1>
        <p>{intro}</p>
        <p className="notice" role="note">{t('admin.placeholder')}</p>
        {children}
      </main>
    </div>
  );
}
