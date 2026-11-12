import { AdminPage } from '@/components/admin-page';
import { AdjustmentsPanel } from '@/components/admin/pricing/adjustments-panel';
import { t } from '@/lib/i18n';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined): string | undefined => {
  const x = Array.isArray(v) ? v[0] : v;
  return x && UUID.test(x) ? x : undefined;
};

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return (
    <AdminPage current="/admin/pricing" title={t('admin.pricing.title')} intro={t('admin.pricing.intro')} placeholder={false}>
      <AdjustmentsPanel packageId={one(params.packageId)} editionId={one(params.editionId)} />
    </AdminPage>
  );
}
