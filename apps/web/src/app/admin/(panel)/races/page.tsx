import { AdminPage } from '@/components/admin-page';
import { t } from '@/lib/i18n';

export default function Page() {
  return <AdminPage current="/admin/races" title={t('admin.races.title')} intro={t('admin.races.intro')} />;
}
