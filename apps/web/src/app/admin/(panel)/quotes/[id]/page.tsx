import { AdminPage } from '@/components/admin-page';
import { QuoteDetail } from '@/components/admin/crm/quotes';
import { t } from '@/lib/i18n';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminPage current="/admin/quotes" title={t('admin.crm.quote.title')} intro={t('admin.crm.quote.intro')} placeholder={false}>
      <QuoteDetail id={id ?? ''} />
    </AdminPage>
  );
}
