import { AdminPage } from '@/components/admin-page';
import { BookingsInbox } from '@/components/admin/crm/inbox';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/bookings" title={t('admin.bookings.title')} intro={t('admin.bookings.intro')} placeholder={false}>
      <BookingsInbox />
    </AdminPage>
  );
}
