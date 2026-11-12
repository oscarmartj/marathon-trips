import { AdminPage } from '@/components/admin-page';
import { VersionsPanel } from '@/components/admin/pricing/versions-panel';
import { t } from '@/lib/i18n';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/packages" title={t('admin.pricing.versions.title')} intro={t('admin.pricing.versions.intro')} placeholder={false}>
      <VersionsPanel packageId={id ?? ''} />
    </AdminPage>
  );
}
