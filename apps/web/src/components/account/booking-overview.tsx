import Link from 'next/link';
import type { AccountPaymentRecord, BookingTravellersView, PaymentPlanView } from '@mt/shared';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { formatInstant, notPayableKey } from '@/lib/checkout';
import { documentHref, documentKinds, statusKey } from '@/lib/account';
import { t } from '@/lib/i18n';
import { progress, showTravellerSection, travellerHref } from '@/lib/travellers';
import { DeadlineNote } from '@/components/account/traveller-forms';

export interface AccountBookingDetail {
  booking: {
    reference: string;
    status: string;
    departureDate: string;
    returnDate: string;
    currency: string;
    totalMinor: string;
    depositMinor: string;
    package: { name: Record<string, string>; editionYear: number; race: { name: Record<string, string> } };
    price: { subtotals?: { accommodation?: string; participation?: string; extras?: string } };
  };
  plan: PaymentPlanView;
  payments: AccountPaymentRecord[];
  documents: string[];
}

/**
 * One booking in the customer area (task 5.1): its status in plain words, the trip, the price and the payment plan as
 * the API holds them, the payments received and the documents available. "Pay now" appears only when the API says
 * the booking can take a payment; the amount is the plan's, shown at checkout.
 */
export function BookingOverview({ view, travellers = null }: { view: AccountBookingDetail; travellers?: BookingTravellersView | null }) {
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

      <p><Link href="/account">{t('account.detail.back')}</Link></p>
    </div>
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
