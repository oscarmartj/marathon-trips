import Link from 'next/link';
import { brand } from '@mt/shared/brand';
import { t } from '@/lib/i18n';

/** Logo from the brand config. The mark is decorative; the brand name is the visible text. */
export function Logo() {
  return (
    <Link href="/" className="logo" aria-label={t('common.logoLabel')}>
      <svg viewBox={brand.logo.markViewBox} aria-hidden="true" focusable="false">
        <path d={brand.logo.markPath} />
      </svg>
      <span aria-hidden="true">{brand.name}</span>
    </Link>
  );
}
