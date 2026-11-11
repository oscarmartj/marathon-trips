import { PageHeader } from '@/components/page-header';
import { MagicLinkVerify } from '@/components/auth/magic-link-verify';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <>
      <PageHeader title={t('auth.customer.verifyTitle')} intro={t('auth.customer.signInIntro')} />
      <div className="container stack">
        <MagicLinkVerify />
      </div>
    </>
  );
}
