import { PageHeader } from '@/components/page-header';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';

/**
 * The last day the places are held: the Brisbane day of the instant just before the hold ends, so a hold that ends at
 * 00:00 on the departure day reads as the day before, never as the departure day.
 */
export const lastHeldDay = (iso: string): string => dateInBrisbane(new Date(new Date(iso).getTime() - 1).toISOString());

/** The calendar day of an instant in the business time zone (Australia/Brisbane, no daylight saving), as YYYY-MM-DD. */
export const dateInBrisbane = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export interface RequestView {
  reference: string;
  status: string;
  isRequest: boolean;
  requestExpiresAt: string;
  departureDate: string;
  returnDate: string;
  balanceDueDate: string;
  currency: string;
  totalMinor: string;
  depositMinor: string;
  package: { name: Record<string, string> };
}

/**
 * What the customer sees after sending a request (task 2.4): first and plainly, that it is a request and not a
 * confirmed booking, and that nothing has been charged; then the reference, the trip and the price the API stored.
 */
export function RequestConfirmation({ view }: { view: RequestView }) {
  const requested = view.status === 'requested';
  return (
    <>
      <PageHeader title={requested ? t('bookingRequest.confirmation.heading') : t('bookingRequest.confirmation.statusHeading')} intro={localisedText(view.package.name)} />
      <div className="container stack section">
        {requested ? (
          <div className="notice" role="status">
            <p>{t('bookingRequest.confirmation.notABooking')}</p>
            <p>{t('bookingRequest.confirmation.nothingCharged')}</p>
            <p>{t('bookingRequest.confirmation.next', { date: formatDate(lastHeldDay(view.requestExpiresAt)) })}</p>
          </div>
        ) : (
          <p className="notice" role="status">{t(`bookingRequest.status.${view.status}`)}</p>
        )}
        {view.status === 'approved' || view.status === 'deposit_paid' ? (
          <p><a className="btn" href={`/checkout/${encodeURIComponent(view.reference)}`}>{t('bookingRequest.confirmation.continueToPayment')}</a></p>
        ) : null}
        <p><a href={`/account/bookings/${encodeURIComponent(view.reference)}`}>{t('bookingRequest.confirmation.inAccount')}</a></p>
        <dl>
          <dt>{t('bookingRequest.confirmation.reference')}</dt>
          <dd>{view.reference}</dd>
          <dt>{t('bookingRequest.confirmation.dates')}</dt>
          <dd>{t('bookingRequest.confirmation.dateRange', { from: formatDate(view.departureDate), to: formatDate(view.returnDate) })}</dd>
          <dt>{t('bookingRequest.confirmation.total')}</dt>
          <dd>{formatMoney(view.totalMinor, view.currency)}</dd>
          <dt>{t('bookingRequest.confirmation.deposit')}</dt>
          <dd>{t('bookingRequest.confirmation.depositLine', { amount: formatMoney(view.depositMinor, view.currency), date: formatDate(view.balanceDueDate) })}</dd>
        </dl>
      </div>
    </>
  );
}

