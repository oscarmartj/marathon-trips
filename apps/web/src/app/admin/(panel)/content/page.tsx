import { AdminPage } from '@/components/admin-page';
import { ContentOverview } from '@/components/admin/content/content-manager';
import { ADMIN_KINDS } from '@/lib/content-admin';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/content" title={t('admin.content.title')} intro={t('admin.content.intro')} placeholder={false}>
      <ContentOverview kinds={ADMIN_KINDS} />
    </AdminPage>
  );
}
