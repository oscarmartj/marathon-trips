import { AdminPage } from '@/components/admin-page';
import { FlagsPanel } from '@/components/admin/flags-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/flags" title={t('admin.flags.title')} intro={t('admin.flags.intro')} placeholder={false}>
      <FlagsPanel />
    </AdminPage>
  );
}
