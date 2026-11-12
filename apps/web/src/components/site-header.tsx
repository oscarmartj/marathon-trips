import { Logo } from './logo';
import { MenuLinks } from './menu-links';
import { getMenu } from '@/lib/content';
import { publicRoutes } from '@/lib/routes';
import { t } from '@/lib/i18n';

/** The main menu is the one staff manage in the content manager; with none published, the built-in pages are shown. */
export async function SiteHeader() {
  const { header } = await getMenu();
  const items = header.length > 0 ? header : publicRoutes.filter((r) => r.nav).map((r) => ({ label: t(r.labelKey), href: r.path }));
  return (
    <header className="site-header">
      <div className="container">
        <Logo />
        <nav aria-label={t('common.mainNavigation')}>
          <MenuLinks items={items} />
        </nav>
      </div>
    </header>
  );
}
