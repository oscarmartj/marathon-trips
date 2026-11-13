import { AdminPage } from '@/components/admin-page';
import { ReportsPanel } from '@/components/admin/reports/reports-panel';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/reports" title={t('admin.reports.title')} intro={t('admin.reports.intro')} placeholder={false}>
      <ReportsPanel />
    </AdminPage>
  );
}
