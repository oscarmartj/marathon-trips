import Link from 'next/link';
import { AdminPage } from '@/components/admin-page';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AdminPage current="/admin/settings" title={t('admin.settings.title')} intro={t('admin.settings.intro')}>
      <section aria-labelledby="settings-custom-fields" className="card stack">
        <h2 id="settings-custom-fields">
          <Link href="/admin/settings/custom-fields">{t('admin.settings.customFieldsLink')}</Link>
        </h2>
        <p>{t('admin.settings.customFieldsHelp')}</p>
      </section>
    </AdminPage>
  );
}
