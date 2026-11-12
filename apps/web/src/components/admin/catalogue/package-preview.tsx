'use client';

import Link from 'next/link';
import { bpsToPercent, enAU, minorToDollars } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { formatDay, useLoad } from './kit';

type Availability = 'available' | 'low' | 'none';
interface Preview {
  id: string;
  name: unknown;
  saleStatus: string;
  raceStatus: string;
  editionStatus: string;
  isDemo: boolean;
  currency: string;
  race: { name: unknown; claims: string[] };
  edition: { year: number; startDate: string | null; dateConfirmed: boolean };
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  includes: unknown;
  excludes: unknown;
  deposit: { mode: string; amountMinor?: string; bps?: number } | null;
  balanceDueDate: string;
  minTravellers: number;
  maxTravellers: number;
  participation: string[];
  guaranteedEntry: boolean;
  entries: Array<{ id: string; distance: { name: unknown }; availability: Availability }>;
  hotels: Array<{ id: string; name: string; city: string; starRating: number | null; description: unknown; rooms: Array<{ id: string; roomType: string; name: unknown; minOccupancy: number; maxOccupancy: number; availability: Availability }> }>;
  extras: Array<{ id: string; kind: string; name: unknown; description: unknown; pricingUnit: string; mandatory: boolean; availability: Availability }>;
}

const lines = (v: unknown): string[] => enAU(v).split('\n').map((x) => x.trim()).filter(Boolean);

/**
 * What a visitor will see of this package, built by the same code as the public site. It shows base information only:
 * no totals, and the deposit exactly as configured. Stock appears as a word, never a number.
 */
export function PackagePreview({ id }: { id: string }) {
  const { data: p, error } = useLoad<Preview>(`/admin/catalogue/packages/${id}/preview`);
  if (!p) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  const state = (a: Availability) => t(`admin.catalogue.preview.availability.${a}`);
  const live = p.saleStatus !== 'draft' && p.raceStatus === 'published' && p.editionStatus !== 'draft' && !p.isDemo;

  return (
    <div className="stack">
      <p>
        <Link href={`/admin/packages/${id}`}>{t('admin.catalogue.preview.back')}</Link>
      </p>
      <p className="notice" role="note">
        {t(live ? 'admin.catalogue.preview.bannerLive' : 'admin.catalogue.preview.bannerHidden', { status: t(`admin.catalogue.saleStatuses.${p.saleStatus}`) })}
      </p>
      <article className="card stack" aria-labelledby="preview-title">
        <h2 id="preview-title">{enAU(p.name)}</h2>
        <p>{t('admin.catalogue.preview.raceLine', { race: enAU(p.race.name), year: p.edition.year })}</p>
        {p.edition.dateConfirmed ? null : <p className="notice">{t('admin.catalogue.editions.provisionalNotice')}</p>}
        {p.guaranteedEntry ? <p><span className="badge">{t('admin.catalogue.preview.guaranteedEntry')}</span></p> : null}
        <p>{t('admin.catalogue.preview.stay', { from: formatDay(p.checkInDate), to: formatDay(p.checkOutDate), nights: p.nights })}</p>
        <p>{t('admin.catalogue.preview.travellers', { min: p.minTravellers, max: p.maxTravellers })}</p>
        <p>{p.participation.map((x) => t(`admin.catalogue.participation.${x}`)).join(', ') || t('admin.catalogue.preview.noParticipation')}</p>
        <p>
          {p.deposit
            ? p.deposit.mode === 'percent'
              ? t('admin.catalogue.packages.depositPercent', { amount: bpsToPercent(p.deposit.bps ?? 0) })
              : t(p.deposit.mode === 'per_person' ? 'admin.catalogue.packages.depositPerPerson' : 'admin.catalogue.packages.depositPerBooking', { amount: `${p.currency} ${minorToDollars(p.deposit.amountMinor ?? '0')}` })
            : t('admin.catalogue.packages.depositNone')}
          {' '}
          {t('admin.catalogue.preview.balanceDue', { date: formatDay(p.balanceDueDate) })}
        </p>
        <p>{t('admin.catalogue.preview.pricesNote')}</p>

        {p.entries.length > 0 ? (
          <>
            <h3>{t('admin.catalogue.preview.entries')}</h3>
            <ul>
              {p.entries.map((e) => (
                <li key={e.id}>{t('admin.catalogue.preview.line', { name: enAU(e.distance.name), state: state(e.availability) })}</li>
              ))}
            </ul>
          </>
        ) : null}
        {p.hotels.length > 0 ? (
          <>
            <h3>{t('admin.catalogue.preview.hotels')}</h3>
            {p.hotels.map((h) => (
              <div key={h.id} className="stack">
                <h4>{h.starRating ? t('admin.catalogue.preview.hotelStars', { name: h.name, count: h.starRating }) : h.name}</h4>
                <p>{h.city}</p>
                {enAU(h.description) ? <p>{enAU(h.description)}</p> : null}
                <ul>
                  {h.rooms.map((r) => (
                    <li key={r.id}>{t('admin.catalogue.preview.roomLine', { name: enAU(r.name), min: r.minOccupancy, max: r.maxOccupancy, state: state(r.availability) })}</li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : null}
        {p.extras.length > 0 ? (
          <>
            <h3>{t('admin.catalogue.preview.extras')}</h3>
            <ul>
              {p.extras.map((x) => (
                <li key={x.id}>
                  {t('admin.catalogue.preview.line', { name: enAU(x.name), state: state(x.availability) })}
                  {x.mandatory ? ` ${t('admin.catalogue.packages.mandatoryTag')}` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {lines(p.includes).length > 0 ? (
          <>
            <h3>{t('admin.catalogue.preview.includes')}</h3>
            <ul>
              {lines(p.includes).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </>
        ) : null}
        {lines(p.excludes).length > 0 ? (
          <>
            <h3>{t('admin.catalogue.preview.excludes')}</h3>
            <ul>
              {lines(p.excludes).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </>
        ) : null}
      </article>
    </div>
  );
}
