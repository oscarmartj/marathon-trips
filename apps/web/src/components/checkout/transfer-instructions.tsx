import type { ManualInstructionsView } from '@mt/shared';
import { formatMoney } from '@/lib/builder';
import { formatInstant } from '@/lib/checkout';
import { t } from '@/lib/i18n';

/**
 * How to pay by PayID or bank transfer (task 3.4). Every figure is what the API sent: the amount, the payee, the PayID
 * or account, and the reference the payer must write on the transfer so staff can match it. Nothing is computed here.
 */
export function TransferInstructions({ instructions }: { instructions: ManualInstructionsView }) {
  const i = instructions;
  return (
    <section className="stack" aria-labelledby="transfer-heading">
      <h2 id="transfer-heading">{t('checkout.transfer.heading')}</h2>
      <p role="status">{t('checkout.transfer.intro', { amount: formatMoney(i.amountMinor, i.currency) })}</p>
      <dl>
        <div>
          <dt>{t('checkout.transfer.payee')}</dt>
          <dd>{i.payeeName}</dd>
        </div>
        {i.payId ? (
          <div>
            <dt>{t(`checkout.transfer.payIdType.${i.payId.type}`)}</dt>
            <dd><strong>{i.payId.value}</strong></dd>
          </div>
        ) : null}
        {i.bank ? (
          <>
            <div>
              <dt>{t('checkout.transfer.bsb')}</dt>
              <dd>{i.bank.bsb}</dd>
            </div>
            <div>
              <dt>{t('checkout.transfer.accountNumber')}</dt>
              <dd>{i.bank.accountNumber}</dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>{t('checkout.transfer.amount')}</dt>
          <dd>{formatMoney(i.amountMinor, i.currency)}</dd>
        </div>
        <div>
          <dt>{t('checkout.transfer.reference')}</dt>
          <dd><strong>{i.reference}</strong></dd>
        </div>
      </dl>
      <p>{t('checkout.transfer.referenceNote')}</p>
      {i.note ? <p>{i.note}</p> : null}
      <p>{t('checkout.transfer.expires', { when: formatInstant(i.expiresAt) })}</p>
      <p>{t('checkout.transfer.afterwards')}</p>
    </section>
  );
}
