import { PageHeader } from '@/components/page-header';
import { MagicLinkRequestForm } from '@/components/auth/magic-link-request-form';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <>
      <PageHeader title={t('auth.customer.signInTitle')} intro={t('auth.customer.signInIntro')} />
      <div className="container stack">
        <MagicLinkRequestForm />
      </div>
    </>
  );
}
