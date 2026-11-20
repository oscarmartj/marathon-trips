import { AdminPage } from '@/components/admin-page';
import { PackagePreview } from '@/components/admin/catalogue/package-preview';
import { t } from '@/lib/i18n-admin';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/packages" title={t('admin.catalogue.preview.title')} intro={t('admin.catalogue.preview.intro')} placeholder={false}>
      <PackagePreview id={id ?? ''} />
    </AdminPage>
  );
}
