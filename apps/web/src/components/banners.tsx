import Link from 'next/link';
import { isExternalHref, listBanners } from '@/lib/content';
import { t } from '@/lib/i18n';

/**
 * Site-wide banners from the content manager, above the header. Each one says what kind it is in words (not only colour).
 * Nothing is shown when there are none or the content API is unreachable.
 */
export async function Banners() {
  const banners = await listBanners();
  if (banners.length === 0) return null;
  return (
    <section className="banners" aria-label={t('common.announcements')}>
      <ul>
        {banners.map((b) => (
          <li key={b.id} className={`banner banner--${b.tone}`}>
            <span className="banner__tone">{t(`common.bannerTones.${b.tone}`)}</span>
            <span>{b.message}</span>
            {b.linkHref ? (
              isExternalHref(b.linkHref) ? (
                <a href={b.linkHref} rel="noopener noreferrer">{b.linkLabel}</a>
              ) : (
                <Link href={b.linkHref}>{b.linkLabel}</Link>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
