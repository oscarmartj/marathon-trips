import { NavLinks } from './nav-links';
import { publicRoutes } from '@/lib/routes';
import { t } from '@/lib/i18n';

export function SiteFooter() {
  return (
    <footer className="site-footer on-night">
      <div className="container grid grid--3">
        <nav aria-label={t('common.footerNavigation')} className="grid grid--2" style={{ gridColumn: 'span 2' }}>
          <div>
            <h2>{t('common.company')}</h2>
            <NavLinks routes={publicRoutes.filter((r) => r.footer === 'company')} />
          </div>
          <div>
            <h2>{t('common.legal')}</h2>
            <NavLinks routes={publicRoutes.filter((r) => r.footer === 'legal')} />
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
