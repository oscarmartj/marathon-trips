import Link from 'next/link';
import type { AccountBookingItem } from '@mt/shared';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { statusKey } from '@/lib/account';
import { t } from '@/lib/i18n';

/** The customer's bookings, newest first, as the API lists them (task 5.1). Nothing is computed here. */
export function AccountBookings({ items }: { items: AccountBookingItem[] }) {
  if (items.length === 0) return <p>{t('account.list.empty')}</p>;
  return (
    <ul className="stack" aria-label={t('account.list.label')}>
      {items.map((b) => (
        <li key={b.reference} className="card stack">
          <h3>
            <Link href={`/account/bookings/${encodeURIComponent(b.reference)}`}>
              {t('account.list.trip', { race: localisedText(b.package.race.name), year: b.package.editionYear, pkg: localisedText(b.package.name) })}
            </Link>
          </h3>
          <dl>
            <div><dt>{t('account.reference')}</dt><dd>{b.reference}</dd></div>
            <div><dt>{t('account.dates')}</dt><dd>{t('account.dateRange', { from: formatDate(b.departureDate), to: formatDate(b.returnDate) })}</dd></div>
            <div><dt>{t('account.statusLabel')}</dt><dd>{t(`account.status.${statusKey(b.status)}`)}</dd></div>
            <div><dt>{t('account.total')}</dt><dd>{formatMoney(b.totalMinor, b.currency)}</dd></div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
