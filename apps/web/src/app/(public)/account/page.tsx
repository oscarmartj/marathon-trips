import { PageHeader } from '@/components/page-header';
import { AccountSummary } from '@/components/auth/account-summary';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <>
      <PageHeader title={t('auth.customer.accountTitle')} intro={t('common.comingSoon')} />
      <div className="container stack">
        <AccountSummary />
      </div>
    </>
  );
}
