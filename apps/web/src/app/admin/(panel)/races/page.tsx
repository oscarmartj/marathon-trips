import { AdminPage } from '@/components/admin-page';
import { RacesPanel } from '@/components/admin/catalogue/races-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/races" title={t('admin.races.title')} intro={t('admin.races.intro')} placeholder={false}>
      <RacesPanel />
    </AdminPage>
  );
}
