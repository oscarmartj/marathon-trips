import { AdminPage } from '@/components/admin-page';
import { t } from '@/lib/i18n';

export default function Page() {
  return <AdminPage current="/admin/settings" title={t('admin.settings.title')} intro={t('admin.settings.intro')} />;
}
