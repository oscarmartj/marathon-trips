import { AdminPage } from '@/components/admin-page';
import { CancellationPoliciesList } from '@/components/admin/pricing/cancellation-policies';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/cancellation-policies" title={t('admin.pricing.cancellation.title')} intro={t('admin.pricing.cancellation.intro')} placeholder={false}>
      <CancellationPoliciesList />
    </AdminPage>
  );
}
