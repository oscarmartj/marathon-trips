import { AdminPage } from '@/components/admin-page';
import { AccountantExportPanel } from '@/components/admin/finance/accountant-export-panel';
import { CashForecastPanel } from '@/components/admin/finance/cash-forecast-panel';
import { TripResultPanel } from '@/components/admin/finance/trip-result-panel';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/trip-results" title={t('admin.tripResults.title')} intro={t('admin.tripResults.intro')} placeholder={false}>
      <TripResultPanel />
      <CashForecastPanel />
      <AccountantExportPanel />
    </AdminPage>
  );
}
