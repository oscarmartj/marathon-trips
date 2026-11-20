import { AdminPage } from '@/components/admin-page';
import { RaceDetail } from '@/components/admin/catalogue/race-detail';
import { t } from '@/lib/i18n-admin';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/races" title={t('admin.catalogue.races.detailTitle')} intro={t('admin.catalogue.races.detailIntro')} placeholder={false}>
      <RaceDetail id={id ?? ''} />
    </AdminPage>
  );
}
