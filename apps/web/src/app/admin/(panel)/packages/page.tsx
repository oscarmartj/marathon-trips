import { AdminPage } from '@/components/admin-page';
import { PackagesPanel } from '@/components/admin/catalogue/packages-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/packages" title={t('admin.packages.title')} intro={t('admin.packages.intro')} placeholder={false}>
      <PackagesPanel />
    </AdminPage>
  );
}
