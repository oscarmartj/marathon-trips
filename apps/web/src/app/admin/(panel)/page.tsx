import { AdminPage } from '@/components/admin-page';
import { t } from '@/lib/i18n';

export default function Page() {
  return <AdminPage current="/admin" title={t('admin.dashboard.title')} intro={t('admin.dashboard.intro')} />;
}
