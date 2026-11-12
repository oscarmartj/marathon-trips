import { AdminPage } from '@/components/admin-page';
import { CustomFieldsManager } from '@/components/admin/custom-fields/custom-fields-manager';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/settings" title={t('admin.customFields.title')} intro={t('admin.customFields.intro')} placeholder={false}>
      <CustomFieldsManager />
    </AdminPage>
  );
}
