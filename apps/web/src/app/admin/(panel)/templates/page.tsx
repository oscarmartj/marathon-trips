import { AdminPage } from '@/components/admin-page';
import { TemplatesPanel } from '@/components/admin/templates/templates-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/templates" title={t('admin.templates.title')} intro={t('admin.templates.intro')} placeholder={false}>
      <TemplatesPanel />
    </AdminPage>
  );
}
