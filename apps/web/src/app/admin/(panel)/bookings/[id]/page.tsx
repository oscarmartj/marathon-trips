import { AdminPage } from '@/components/admin-page';
import { BookingDetail } from '@/components/admin/crm/inbox';
import { t } from '@/lib/i18n-admin';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/bookings" title={t('admin.crm.booking.title')} intro={t('admin.crm.booking.intro')} placeholder={false}>
      <BookingDetail id={id ?? ''} />
    </AdminPage>
  );
}
