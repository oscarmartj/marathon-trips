import type { Metadata } from 'next';
import { AlertUnsubscribe } from '@/components/alerts/alert-unsubscribe';
import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Page() {
  return (
    <>
      <PageHeader title={t('alerts.unsubscribe.title')} />
      <div className="container stack">
        <AlertUnsubscribe />
      </div>
    </>
  );
}
