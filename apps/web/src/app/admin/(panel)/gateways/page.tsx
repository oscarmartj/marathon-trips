import { AdminPage } from '@/components/admin-page';
import { GatewaysPanel } from '@/components/admin/gateways-panel';
import { RoutingPanel } from '@/components/admin/routing-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/gateways" title={t('admin.gateways.title')} intro={t('admin.gateways.intro')} placeholder={false}>
      <GatewaysPanel />
      <RoutingPanel />
    </AdminPage>
  );
}
