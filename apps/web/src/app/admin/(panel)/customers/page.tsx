import { AdminPage } from '@/components/admin-page';
import { t } from '@/lib/i18n';

export default function Page() {
  return <AdminPage current="/admin/customers" title={t('admin.customers.title')} intro={t('admin.customers.intro')} />;
}
