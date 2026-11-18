import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { MailUnsubscribe } from '@/components/privacy/mail-unsubscribe';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('mailUnsubscribe.title'), robots: { index: false, follow: false } };

export default function Page() {
  return (
    <>
      <PageHeader title={t('mailUnsubscribe.title')} />
      <div className="container stack section">
        <MailUnsubscribe />
      </div>
    </>
  );
}
