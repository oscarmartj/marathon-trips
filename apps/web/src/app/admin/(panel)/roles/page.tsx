import { AdminPage } from '@/components/admin-page';
import { RolesPanel } from '@/components/admin/roles-panel';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/roles" title={t('admin.roles.title')} intro={t('admin.roles.intro')} placeholder={false}>
      <RolesPanel />
    </AdminPage>
  );
}
