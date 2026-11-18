import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { PrivacySettings } from '@/components/privacy/privacy-settings';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('account.privacy.title'), robots: { index: false, follow: false } };

/** The customer's privacy choices (task 5.5). Read in the browser with the session; nothing here is cached. */
export default function Page() {
  return (
    <>
      <PageHeader title={t('account.privacy.title')} intro={t('account.privacy.intro')} />
      <div className="container stack section">
        <PrivacySettings />
      </div>
    </>
  );
}
