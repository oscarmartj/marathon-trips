import { AdminPage } from '@/components/admin-page';
import { CustomerDetail } from '@/components/admin/crm/customers';
import { PrivacyPanel } from '@/components/admin/privacy-panel';
import { t } from '@/lib/i18n';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/customers" title={t('admin.crm.customer.title')} intro={t('admin.crm.customer.intro')} placeholder={false}>
      <CustomerDetail id={id ?? ''} />
      <PrivacyPanel id={id ?? ''} />
    </AdminPage>
  );
}
