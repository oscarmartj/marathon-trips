import Link from 'next/link';
import type { AccountPaymentRecord, BookingTravellersView, PaymentPlanView } from '@mt/shared';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { formatInstant, notPayableKey } from '@/lib/checkout';
import { documentHref, documentKinds, knownReceipts, receiptHref, statusKey } from '@/lib/account';
import type { AccountReceipt } from '@/lib/account';
import { t } from '@/lib/i18n';
import { progress, showTravellerSection, travellerHref } from '@/lib/travellers';
import { DeadlineNote } from '@/components/account/traveller-forms';
import type { ConfigurationView } from '@/lib/amendments';

export interface AccountChange {
  version: number;
  at: string;
  by: 'customer' | 'staff';
  changes: string[];
  currency: string;
  previousTotalMinor: string;
  newTotalMinor: string;
  priceDifferenceMinor: string;
}

export interface AccountBookingDetail {
  booking: {
    reference: string;
    status: string;
    departureDate: string;
    returnDate: string;
    currency: string;
    totalMinor: string;
    depositMinor: string;
    currentSnapshotVersion?: number;
    package: { name: Record<string, string>; slug?: string; editionYear: number; race: { name: Record<string, string>; slug?: string } };
    price: { subtotals?: { accommodation?: string; participation?: string; extras?: string }; configuration?: ConfigurationView };
  };
  /** Task 6.3: the changes made (history) and whether the customer can change nights and extras online. */
  changes?: { items: AccountChange[]; customerChangesEnabled: boolean };
  plan: PaymentPlanView;
  payments: AccountPaymentRecord[];
  documents: string[];
}

/**
 * One booking in the customer area (task 5.1): its status in plain words, the trip, the price and the payment plan as
 * the API holds them, the payments received and the documents available. "Pay now" appears only when the API says
 * the booking can take a payment; the amount is the plan's, shown at checkout.
 */
export function BookingOverview({ view, travellers = null, receipts = null }: { view: AccountBookingDetail; travellers?: BookingTravellersView | null; receipts?: AccountReceipt[] | null }) {
  const { booking: b, plan } = view;
  const cur = b.currency;
  const subtotals = b.price.subtotals ?? {};
  const docs = documentKinds(view.documents);
  return (
    <div className="container stack section">
      <p className="notice" role="status">{t(`account.status.${statusKey(b.status)}`)}</p>

      <section className="stack" aria-labelledby="trip-heading">
        <h2 id="trip-heading">{t('account.detail.tripHeading')}</h2>
        <dl>
          <div><dt>{t('account.reference')}</dt><dd>{b.reference}</dd></div>
          <div><dt>{t('account.detail.trip')}</dt><dd>{t('account.list.trip', { race: localisedText(b.package.race.name), year: b.package.editionYear, pkg: localisedText(b.package.name) })}</dd></div>
          <div><dt>{t('account.dates')}</dt><dd>{t('account.dateRange', { from: formatDate(b.departureDate), to: formatDate(b.returnDate) })}</dd></div>
        </dl>
      </section>

      <section className="stack" aria-labelledby="price-heading">
        <h2 id="price-heading">{t('account.detail.priceHeading')}</h2>
        <dl>
          {(['accommodation', 'participation', 'extras'] as const).map((k) => (subtotals[k] && subtotals[k] !== '0' ? (
            <div key={k}><dt>{t(`account.detail.subtotal.${k}`)}</dt><dd>{formatMoney(subtotals[k]!, cur)}</dd></div>
          ) : null))}
          <div><dt>{t('account.total')}</dt><dd><strong>{formatMoney(b.totalMinor, cur)}</strong></dd></div>
        </dl>
        <p>{t('account.detail.priceNote')}</p>
      </section>

      <section className="stack" aria-labelledby="plan-heading">
        <h2 id="plan-heading">{t('account.detail.planHeading')}</h2>
        {plan.items.length === 0 ? <p>{t('account.detail.noPlan')}</p> : (
          <table>
            <caption className="visually-hidden">{t('account.detail.planCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('account.detail.planItem')}</th>
                <th scope="col">{t('account.detail.planDue')}</th>
                <th scope="col">{t('account.detail.planAmount')}</th>
                <th scope="col">{t('account.detail.planPaid')}</th>
              </tr>
            </thead>
            <tbody>
              {plan.items.map((i) => (
                <tr key={i.sequence}>
                  <th scope="row">{t(`checkout.item.${i.kind}`)}</th>
                  <td>{formatDate(i.dueDate)}</td>
                  <td>{formatMoney(i.amountMinor, plan.currency)}</td>
                  <td>{formatMoney(i.paidMinor, plan.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {plan.items.length > 0 ? <p>{t('account.detail.outstanding', { amount: formatMoney(plan.outstandingMinor, plan.currency) })}</p> : null}
        {plan.depositDueBy ? <p>{t('checkout.payNowUntil', { when: formatInstant(plan.depositDueBy) })}</p> : null}
        {plan.payable && plan.nextPayable ? (
          <p><Link className="btn" href={`/checkout/${encodeURIComponent(b.reference)}`}>{t('account.detail.payNow', { amount: formatMoney(plan.nextPayable.amountMinor, plan.currency) })}</Link></p>
        ) : plan.items.length > 0 && plan.notPayableReason && plan.notPayableReason !== 'nothing_to_pay' && plan.notPayableReason !== 'booking_not_payable' ? (
          <p>{t(`checkout.notPayable.${notPayableKey(plan.notPayableReason)}`)}</p>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="payments-heading">
        <h2 id="payments-heading">{t('account.detail.paymentsHeading')}</h2>
        {view.payments.length === 0 ? <p>{t('account.detail.noPayments')}</p> : (
          <ul>
            {view.payments.map((p, i) => (
              <li key={i}>{t('account.detail.paymentLine', { amount: formatMoney(p.amountMinor, p.currency), when: formatInstant(p.succeededAt), method: t(`checkout.methods.${p.method}`) })}</li>
            ))}
          </ul>
        )}
        <p>{t('account.detail.receiptsNote')}</p>
      </section>

      <ChangesSection view={view} />

      {showTravellerSection(travellers) ? <TravellerSummary reference={b.reference} travellers={travellers} /> : null}

      <section className="stack" aria-labelledby="documents-heading">
        <h2 id="documents-heading">{t('account.detail.documentsHeading')}</h2>
        {docs.length === 0 ? <p>{t('account.detail.noDocuments')}</p> : (
          <ul>
            {docs.map((k) => {
              const href = documentHref(b.reference, k);
              return href ? <li key={k}><a href={href} download>{t(`account.documents.${k}`)}</a></li> : null;
            })}
          </ul>
        )}
      </section>

      {receipts ? <ReceiptsSection reference={b.reference} receipts={receipts} /> : null}

      <p><Link href="/account">{t('account.detail.back')}</Link></p>
    </div>
  );
}

/** Task 4.6: a receipt for each payment and a note for each refund or chargeback, as PDFs the API builds. */
function ReceiptsSection({ reference, receipts }: { reference: string; receipts: AccountReceipt[] }) {
  const known = knownReceipts(receipts);
  return (
    <section className="stack" aria-labelledby="receipts-heading">
      <h2 id="receipts-heading">{t('account.receipts.heading')}</h2>
      {known.length === 0 ? <p>{t('account.receipts.none')}</p> : (
        <ul>
          {known.map((r) => {
            const href = receiptHref(reference, r.number);
            return href ? <li key={r.number}><a href={href} download>{t('account.receipts.link', { title: t(`account.receipts.kinds.${r.kind}`), number: r.number, amount: formatMoney(r.amountMinor, r.currency) })}</a></li> : null;
          })}
        </ul>
      )}
    </section>
  );
}

function TravellerSummary({ reference, travellers }: { reference: string; travellers: BookingTravellersView }) {
  const { done, total } = progress(travellers);
  const href = travellerHref(reference);
  return (
    <section className="stack" aria-labelledby="travellers-heading">
      <h2 id="travellers-heading">{t('account.travellers.summary.heading')}</h2>
      <p>{t('account.travellers.summary.progress', { done, total })}</p>
      <DeadlineNote view={travellers} />
      {href ? <p><Link href={href}>{t(travellers.editable ? 'account.travellers.summary.manage' : 'account.travellers.summary.view')}</Link></p> : null}
    </section>
  );
}

/**
 * Changes made to the booking (task 6.3): the history as recorded, and what is owed back NOW from the payment plan (never
 * the amount a past change recorded). A credit is pending: refunds are not available online yet.
 */
function ChangesSection({ view }: { view: AccountBookingDetail }) {
  const changes = view.changes;
  if (!changes) return null;
  const credit = view.plan.overpaidMinor;
  return (
    <section className="stack" aria-labelledby="changes-heading">
      <h2 id="changes-heading">{t('amendments.changesHeading')}</h2>
      {changes.items.length === 0 ? <p>{t('amendments.noChanges')}</p> : (
        <ul>
          {changes.items.map((c) => (
            <li key={c.version}>
              {t('amendments.changeLine', {
                when: formatInstant(c.at), by: t(`amendments.by.${c.by}`), what: c.changes.map((k) => t(`amendments.kinds.${k}`)).join(', '),
                from: formatMoney(c.previousTotalMinor, c.currency), to: formatMoney(c.newTotalMinor, c.currency), difference: formatMoney(c.priceDifferenceMinor, c.currency),
              })}
            </li>
          ))}
        </ul>
      )}
      {credit && credit !== '0' ? <p className="notice" role="status">{t('amendments.creditPending', { amount: formatMoney(credit, view.plan.currency) })}</p> : null}
      {changes.customerChangesEnabled ? (
        <p><Link href={`/account/bookings/${encodeURIComponent(view.booking.reference)}/change`}>{t('amendments.changeLink')}</Link></p>
      ) : <p>{t('amendments.contactUs')}</p>}
    </section>
  );
}
