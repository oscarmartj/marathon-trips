import { MenuLinks } from './menu-links';
import { getMenu } from '@/lib/content';
import { publicRoutes } from '@/lib/routes';
import { t } from '@/lib/i18n';

const builtIn = (group: 'company' | 'legal') => publicRoutes.filter((r) => r.footer === group).map((r) => ({ label: t(r.labelKey), href: r.path }));

/** Footer links come from the content manager; a group with nothing published shows the built-in links. */
export async function SiteFooter() {
  const menu = await getMenu();
  return (
    <footer className="site-footer on-night">
      <div className="container grid grid--3">
        <nav aria-label={t('common.footerNavigation')} className="grid grid--2" style={{ gridColumn: 'span 2' }}>
          <div>
            <h2>{t('common.company')}</h2>
            <MenuLinks items={menu.footer_company.length > 0 ? menu.footer_company : builtIn('company')} />
          </div>
          <div>
            <h2>{t('common.legal')}</h2>
            <MenuLinks items={menu.footer_legal.length > 0 ? menu.footer_legal : builtIn('legal')} />
          </div>
        </nav>
        <div>
          <p>{t('footer.rights')}</p>
          <p>{t('footer.note')}</p>
        </div>
      </div>
    </footer>
  );
}
