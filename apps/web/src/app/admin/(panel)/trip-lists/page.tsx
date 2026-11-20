import { AdminPage } from '@/components/admin-page';
import { TripListsPanel } from '@/components/admin/triplists/trip-lists-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/trip-lists" title={t('admin.triplists.title')} intro={t('admin.triplists.intro')} placeholder={false}>
      <TripListsPanel />
    </AdminPage>
  );
}
