import { AdminPage } from '@/components/admin-page';
import { KeyDatesPanel } from '@/components/admin/keydates/keydates-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/key-dates" title={t('admin.keydates.title')} intro={t('admin.keydates.intro')} placeholder={false}>
      <KeyDatesPanel />
    </AdminPage>
  );
}
