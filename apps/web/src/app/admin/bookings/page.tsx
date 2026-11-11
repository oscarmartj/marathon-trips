import { AdminPage } from '@/components/admin-page';
import { t } from '@/lib/i18n';

export default function Page() {
  return <AdminPage current="/admin/bookings" title={t('admin.bookings.title')} intro={t('admin.bookings.intro')} />;
}
