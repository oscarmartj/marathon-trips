import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminPage } from '@/components/admin-page';
import { ContentManager } from '@/components/admin/content/content-manager';
import { isAdminKind } from '@/lib/content-admin';
import { t } from '@/lib/i18n-admin';

export default async function Page({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isAdminKind(kind)) notFound();
  return (
    <AdminPage current="/admin/content" title={t('admin.content.kindTitle', { kind: t(`admin.content.kinds.${kind}`) })} intro={t('admin.content.kindIntro')} placeholder={false}>
      <p><Link href="/admin/content">{t('admin.content.backToContent')}</Link></p>
      <ContentManager kind={kind} />
    </AdminPage>
  );
}
