import { AdminPage } from '@/components/admin-page';
import { ComplaintsPanel } from '@/components/admin/complaints/complaints-panel';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/complaints" title={t('admin.complaints.title')} intro={t('admin.complaints.intro')} placeholder={false}>
      <ComplaintsPanel />
    </AdminPage>
  );
}
