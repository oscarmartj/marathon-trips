import { AdminPage } from '@/components/admin-page';
import { ComplaintDetail } from '@/components/admin/complaints/complaint-detail';
import { t } from '@/lib/i18n-admin';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/complaints" title={t('admin.complaints.detailTitle')} intro={t('admin.complaints.detailIntro')} placeholder={false}>
      <ComplaintDetail id={id ?? ''} />
    </AdminPage>
  );
}
