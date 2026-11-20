import { AdminPage } from '@/components/admin-page';
import { DashboardPanel } from '@/components/admin/dashboard/dashboard-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin" title={t('admin.dashboard.title')} intro={t('admin.dashboard.intro')} placeholder={false}>
      <DashboardPanel />
    </AdminPage>
  );
}
