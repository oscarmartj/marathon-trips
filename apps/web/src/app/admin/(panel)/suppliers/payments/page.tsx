import { AdminPage } from '@/components/admin-page';
import { SupplierSchedulePanel } from '@/components/admin/suppliers/supplier-schedule';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/suppliers/payments" title={t('admin.nav.supplierPayments')} intro={t('admin.suppliers.payments.notice')} placeholder={false}>
      <SupplierSchedulePanel />
    </AdminPage>
  );
}
