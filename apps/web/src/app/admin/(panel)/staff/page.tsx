import { AdminPage } from '@/components/admin-page';
import { StaffPanel } from '@/components/admin/staff-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/staff" title={t('admin.staff.title')} intro={t('admin.staff.intro')} placeholder={false}>
      <StaffPanel />
    </AdminPage>
  );
}
