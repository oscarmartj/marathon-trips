import { AdminPage } from '@/components/admin-page';
import { AutomationsPanel } from '@/components/admin/automations/automations-panel';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/automations" title={t('admin.automations.title')} intro={t('admin.automations.intro')} placeholder={false}>
      <AutomationsPanel />
    </AdminPage>
  );
}
