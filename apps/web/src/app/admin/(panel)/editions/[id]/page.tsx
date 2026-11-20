import { AdminPage } from '@/components/admin-page';
import { EditionDetail } from '@/components/admin/catalogue/edition-detail';
import { t } from '@/lib/i18n-admin';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/races" title={t('admin.catalogue.editions.detailTitle')} intro={t('admin.catalogue.editions.detailIntro')} placeholder={false}>
      <EditionDetail id={id ?? ''} />
    </AdminPage>
  );
}
