import { AdminPage } from '@/components/admin-page';
import { CancellationPolicyEditor } from '@/components/admin/pricing/cancellation-policies';
import { t } from '@/lib/i18n';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/cancellation-policies" title={t('admin.pricing.cancellation.editTitle')} intro={t('admin.pricing.cancellation.intro')} placeholder={false}>
      <CancellationPolicyEditor id={id ?? ''} />
    </AdminPage>
  );
}
