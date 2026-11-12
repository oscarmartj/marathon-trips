import { AdminPage } from '@/components/admin-page';
import { HotelsPanel } from '@/components/admin/catalogue/hotels-panel';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/hotels" title={t('admin.catalogue.hotels.title')} intro={t('admin.catalogue.hotels.intro')} placeholder={false}>
      <HotelsPanel />
    </AdminPage>
  );
}
