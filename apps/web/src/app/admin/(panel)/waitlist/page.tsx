import { AdminPage } from '@/components/admin-page';
import { WaitlistPanel } from '@/components/admin/waitlist/waitlist-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/waitlist" title={t('admin.waitlist.title')} intro={t('admin.waitlist.intro')} placeholder={false}>
      <WaitlistPanel />
    </AdminPage>
  );
}
