import { AdminPage } from '@/components/admin-page';
import { SuppliersPanel } from '@/components/admin/suppliers/suppliers-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/suppliers" title={t('admin.suppliers.title')} intro={t('admin.suppliers.intro')} placeholder={false}>
      <SuppliersPanel />
    </AdminPage>
  );
}
