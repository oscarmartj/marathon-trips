import { AdminPage } from '@/components/admin-page';
import { SupplierSchedulePanel } from '@/components/admin/suppliers/supplier-schedule';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/suppliers/payments" title={t('admin.supplierSchedule.title')} intro={t('admin.supplierSchedule.intro')} placeholder={false}>
      <SupplierSchedulePanel />
    </AdminPage>
  );
}
