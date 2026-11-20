import { AdminPage } from '@/components/admin-page';
import { VersionDetailView } from '@/components/admin/pricing/version-detail';
import { t } from '@/lib/i18n-admin';

export default async function Page({ params }: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await params;
  return (
    <AdminPage current="/admin/packages" title={t('admin.pricing.detail.title')} intro={t('admin.pricing.detail.intro')} placeholder={false}>
      <VersionDetailView packageId={id ?? ''} versionId={versionId ?? ''} />
    </AdminPage>
  );
}
