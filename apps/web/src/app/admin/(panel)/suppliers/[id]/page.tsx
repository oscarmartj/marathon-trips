import { AdminPage } from '@/components/admin-page';
import { SupplierDetail } from '@/components/admin/suppliers/supplier-detail';
import { t } from '@/lib/i18n';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/suppliers" title={t('admin.suppliers.detailTitle')} intro={t('admin.suppliers.detailIntro')} placeholder={false}>
      <SupplierDetail id={id ?? ''} />
    </AdminPage>
  );
}
