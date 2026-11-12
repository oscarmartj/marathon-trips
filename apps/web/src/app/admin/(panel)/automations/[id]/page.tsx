import { AdminPage } from '@/components/admin-page';
import { AutomationDetail } from '@/components/admin/automations/automation-detail';
import { t } from '@/lib/i18n';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/automations" title={t('admin.automations.detailTitle')} intro={t('admin.automations.detailIntro')} placeholder={false}>
      <AutomationDetail id={id ?? ''} />
    </AdminPage>
  );
}
