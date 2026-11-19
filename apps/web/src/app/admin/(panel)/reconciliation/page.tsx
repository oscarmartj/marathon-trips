import { AdminPage } from '@/components/admin-page';
import { ReconciliationPanel } from '@/components/admin/reconciliation-panel';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/reconciliation" title={t('admin.reconciliation.title')} intro={t('admin.reconciliation.intro')} placeholder={false}>
      <ReconciliationPanel />
    </AdminPage>
  );
}
