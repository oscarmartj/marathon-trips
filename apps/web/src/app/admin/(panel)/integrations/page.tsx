import { AdminPage } from '@/components/admin-page';
import { IntegrationsPanel } from '@/components/admin/integrations-panel';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/integrations" title={t('admin.integrations.title')} intro={t('admin.integrations.intro')} placeholder={false}>
      <IntegrationsPanel />
    </AdminPage>
  );
}
