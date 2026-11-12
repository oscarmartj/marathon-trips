import { AdminPage } from '@/components/admin-page';
import { QuotesPanel } from '@/components/admin/crm/quotes';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/quotes" title={t('admin.crm.quotes.title')} intro={t('admin.crm.quotes.intro')} placeholder={false}>
      <QuotesPanel />
    </AdminPage>
  );
}
