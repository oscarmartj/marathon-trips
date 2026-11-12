'use client';

import Link from 'next/link';
import { t } from '@/lib/i18n';
import { useLoad } from './kit';

interface LowStockItem {
  id: string;
  kind: string;
  label: string;
  remaining: number;
  capacity: number;
  state: 'low' | 'none' | 'available';
  edition: { id: string; year: number };
  race: { id: string; name: string };
}

/** The low-stock warning (task 1.2): pools that are running low or have run out, with a link to their edition. */
export function LowStockNotice({ editionId }: { editionId?: string }) {
  const { data } = useLoad<{ items: LowStockItem[] }>('/admin/catalogue/low-stock');
  const items = (data?.items ?? []).filter((i) => !editionId || i.edition.id === editionId);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="low-stock-title" className="notice stack" role="status">
      <h2 id="low-stock-title">{t('admin.catalogue.lowStock.title', { count: items.length })}</h2>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <Link href={`/admin/editions/${i.edition.id}`}>{t('admin.catalogue.lowStock.where', { race: i.race.name, year: i.edition.year })}</Link>
            {': '}
            {t(`admin.catalogue.poolKinds.${i.kind}`)} {i.label}, {i.state === 'none' ? t('admin.catalogue.lowStock.none') : t('admin.catalogue.lowStock.left', { remaining: i.remaining, capacity: i.capacity })}
          </li>
        ))}
      </ul>
    </section>
  );
}
