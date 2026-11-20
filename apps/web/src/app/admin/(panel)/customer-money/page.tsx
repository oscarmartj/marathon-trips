import { AdminPage } from '@/components/admin-page';
import { CustomerMoneyPanel } from '@/components/admin/customer-money-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/customer-money" title={t('admin.customerMoney.title')} intro={t('admin.customerMoney.intro')} placeholder={false}>
      <CustomerMoneyPanel />
    </AdminPage>
  );
}
