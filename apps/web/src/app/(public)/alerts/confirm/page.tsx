import type { Metadata } from 'next';
import { AlertConfirm } from '@/components/alerts/alert-confirm';
import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';

// The link is private to one person: keep it out of search results.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Page() {
  return (
    <>
      <PageHeader title={t('alerts.confirm.title')} intro={t('alerts.confirm.intro')} />
      <div className="container stack">
        <AlertConfirm />
      </div>
    </>
  );
}
