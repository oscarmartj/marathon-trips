import { AdminPage } from '@/components/admin-page';
import { t } from '@/lib/i18n';

export default function Page() {
  return <AdminPage current="/admin/packages" title={t('admin.packages.title')} intro={t('admin.packages.intro')} />;
}
