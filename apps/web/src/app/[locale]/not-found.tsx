import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { lp, t } from '@/lib/i18n';

export default function NotFound() {
  return (
    <>
      <PageHeader title={t('pages.notFoundTitle')} />
      <div className="container">
        <p>
          <Link href={lp('/')}>{t('nav.home')}</Link>
        </p>
      </div>
    </>
  );
}
