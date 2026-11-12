'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SALE_STATUSES } from '@mt/shared';
import { enAU } from '@/lib/catalogue';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { Section, formatDay, useLoad } from './kit';
import { LowStockNotice } from './low-stock-notice';

interface PackageRow {
  id: string;
  slug: string;
  name: unknown;
  saleStatus: string;
  checkInDate: string;
  checkOutDate: string;
  edition: { id: string; year: number };
  race: { id: string; slug: string; name: unknown };
}
interface Page {
  items: PackageRow[];
  total: number;
}
const PAGE_SIZE = 20;

/** Every package across editions, with search and a sale status filter. Packages are created from their edition. */
export function PackagesPanel() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ q: '', status: '' });
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(applied.q ? { q: applied.q } : {}), ...(applied.status ? { saleStatus: applied.status } : {}) });
  const { data, error } = useLoad<Page>(`/admin/catalogue/packages?${params.toString()}`);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="stack">
      <LowStockNotice />
      <Section id="packages-list" title={t('admin.catalogue.packages.listTitle')}>
        <p>{t('admin.catalogue.packages.createdFromEdition')}</p>
        <form
          className="inline-form"
          role="search"
          aria-label={t('admin.catalogue.packages.searchLabel')}
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ q: q.trim(), status });
            setPage(1);
          }}
        >
          <div className="field">
            <label htmlFor="packages-q">{t('admin.catalogue.common.search')}</label>
            <input id="packages-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="packages-status">{t('admin.catalogue.packages.fields.saleStatus')}</label>
            <select id="packages-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('admin.catalogue.common.anyStatus')}</option>
              {SALE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`admin.catalogue.saleStatuses.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit">
            {t('admin.catalogue.common.searchButton')}
          </button>
        </form>
        <Status message={error} />
        {data ? (
          data.items.length === 0 ? (
            <p role="status">{t('admin.catalogue.packages.empty')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption>{t('admin.catalogue.packages.allCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.catalogue.packages.fields.name')}</th>
                    <th scope="col">{t('admin.catalogue.packages.columns.edition')}</th>
                    <th scope="col">{t('admin.catalogue.packages.columns.stay')}</th>
                    <th scope="col">{t('admin.catalogue.packages.fields.saleStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id}>
                      <th scope="row">
                        <Link href={`/admin/packages/${p.id}`}>{enAU(p.name) || p.slug}</Link>
                      </th>
                      <td>
                        <Link href={`/admin/editions/${p.edition.id}`}>{t('admin.catalogue.lowStock.where', { race: enAU(p.race.name) || p.race.slug, year: p.edition.year })}</Link>
                      </td>
                      <td>{t('admin.catalogue.packages.stayShort', { from: formatDay(p.checkInDate), to: formatDay(p.checkOutDate) })}</td>
                      <td>{t(`admin.catalogue.saleStatuses.${p.saleStatus}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
        <nav className="actions" aria-label={t('admin.catalogue.common.pagination')}>
          <button className="btn" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t('admin.catalogue.common.previous')}
          </button>
          <span role="status">{t('admin.catalogue.common.pageOf', { page, pages })}</span>
          <button className="btn" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {t('admin.catalogue.common.next')}
          </button>
        </nav>
      </Section>
    </div>
  );
}
