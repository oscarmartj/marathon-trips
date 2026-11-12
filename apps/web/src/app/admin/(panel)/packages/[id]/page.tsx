import { AdminPage } from '@/components/admin-page';
import { PackageDetail } from '@/components/admin/catalogue/package-detail';
import { t } from '@/lib/i18n';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/packages" title={t('admin.catalogue.packages.detailTitle')} intro={t('admin.catalogue.packages.detailIntro')} placeholder={false}>
      <PackageDetail id={id ?? ''} />
    </AdminPage>
  );
}
