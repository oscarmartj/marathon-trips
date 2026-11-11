import { Logo } from './logo';
import { NavLinks } from './nav-links';
import { publicRoutes } from '@/lib/routes';
import { t } from '@/lib/i18n';

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container">
        <Logo />
        <nav aria-label={t('common.mainNavigation')}>
          <NavLinks routes={publicRoutes.filter((r) => r.nav)} />
        </nav>
      </div>
    </header>
  );
}
