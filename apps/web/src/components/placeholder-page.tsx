import type { ReactNode } from 'react';
import { PageHeader } from './page-header';
import { t } from '@/lib/i18n';

/** Shared body for pages whose real content is built in later tasks. */
export function PlaceholderPage({ title, intro, legal, children }: { title: string; intro: string; legal?: boolean; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} intro={intro} />
      <div className="container stack">
        {legal ? <p className="notice" role="note">{t('common.legalPending')}</p> : null}
        <p>{t('common.comingSoon')}</p>
        {children}
      </div>
    </>
  );
}
