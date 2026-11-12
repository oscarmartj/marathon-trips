import type { PriceBreakdownJson } from '@mt/shared';
import { formatMoney } from '@/lib/builder';
import { localisedText, type PackageDetail } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';

type Line = PriceBreakdownJson['lines'][number];

/** A readable name for a breakdown line, from the package's own names (the API sends ids, not words). */
export function lineLabel(pkg: PackageDetail, breakdown: PriceBreakdownJson, line: Line): string {
  const room = pkg.hotels.flatMap((h) => h.rooms).find((r) => r.id === line.refId);
  const extra = pkg.extras.find((e) => e.id === line.refId);
  switch (line.kind) {
    case 'room':
      return t('builder.line.room', { room: room ? localisedText(room.name) : '' });
    case 'extra_nights':
      return t('builder.line.extraNights', { room: room ? localisedText(room.name) : '', quantity: line.quantity });
    case 'participation': {
      // The line names its traveller; the configuration the API priced says what kind of traveller that is.
      const traveller = breakdown.configuration.rooms.flatMap((r) => r.travellers).find((x) => x.slot === line.travellerSlot);
      const kind = t(`builder.participationTypes.${traveller?.participationType ?? 'runner_own_entry'}`);
      const entry = pkg.entries.find((e) => e.distance.id === line.refId);
      return entry ? t('builder.line.participationDistance', { kind, distance: localisedText(entry.distance.name) || t(`races.distanceKinds.${entry.distance.kind}`) }) : t('builder.line.participation', { kind });
    }
    case 'extra':
      return line.travellerSlot === null && line.quantity > 1
        ? t('builder.line.extraQuantity', { name: extra ? localisedText(extra.name) : '', quantity: line.quantity })
        : t('builder.line.extra', { name: extra ? localisedText(extra.name) : '' });
    case 'promo':
      return t('builder.line.promo');
    default:
      return line.direction === 'surcharge' ? t('builder.line.surcharge') : t('builder.line.discount');
  }
}

const COMPONENTS = ['accommodation', 'participation', 'extras'] as const;

/**
 * The API's answer, drawn as it came. No figure here is computed: every amount is a string from the response,
 * only formatted. Lines are grouped by the component the API gave them.
 */
export function QuoteSummary({ pkg, breakdown }: { pkg: PackageDetail; breakdown: PriceBreakdownJson }) {
  const money = (minor: string, sign: '' | '-' = ''): string => { return formatMoney(minor, breakdown.currency, sign); };
  const promo = breakdown.promo.status;
  return (
    <div className="stack">
      <p className="quote-total">
        <span>{t('builder.total')}</span> <strong data-testid="quote-total">{money(breakdown.totalMinor)}</strong>
      </p>
      <p className="field__hint">{t('builder.includesAll')} {t('builder.currencyNote', { currency: breakdown.currency })}</p>
      <dl className="quote-terms">
        {breakdown.depositMinor !== null && breakdown.balanceMinor !== null && !breakdown.fullPaymentDue ? (
          <>
            <dt>{t('builder.deposit')}</dt>
            <dd data-testid="quote-deposit">{money(breakdown.depositMinor)}</dd>
            <dt>{t('builder.balance')}</dt>
            <dd data-testid="quote-balance">{money(breakdown.balanceMinor)}</dd>
          </>
        ) : null}
      </dl>
      {breakdown.fullPaymentDue || breakdown.depositMinor === null ? <p>{t('builder.payInFull')}</p> : breakdown.balanceDueDate ? <p>{t('builder.balanceDue', { date: formatDate(breakdown.balanceDueDate) })}</p> : null}
      {promo !== 'none' && t(`builder.promo.${promo}`) ? <p className="notice" role="status">{t(`builder.promo.${promo}`)}</p> : null}
      <h3>{t('builder.breakdownHeading')}</h3>
      {COMPONENTS.map((component) => {
        const lines = breakdown.lines.filter((l) => { return l.component === component; });
        if (lines.length === 0) return null;
        return (
          <section key={component} className="stack" aria-labelledby={`quote-${component}`}>
            <h4 id={`quote-${component}`}>{t(`builder.subtotals.${component}`)}</h4>
            <ul className="quote-lines">
              {lines.map((l) => (
                <li key={l.key}>
                  <span>
                    {lineLabel(pkg, breakdown, l)}
                    {l.travellerSlot !== null ? ` (${t('builder.line.forTraveller', { number: l.travellerSlot })})` : ''}
                    {l.cappedFromMinor !== null ? <span className="field__hint"> {t('builder.line.capped')}</span> : null}
                  </span>
                  <span>{money(l.amountMinor, l.direction === 'discount' ? '-' : '')}</span>
                </li>
              ))}
            </ul>
            <p className="quote-subtotal">
              <span>{t(`builder.subtotals.${component}`)}</span> <span>{money(breakdown.subtotals[component])}</span>
            </p>
          </section>
        );
      })}
      {breakdown.lines.some((l) => { return l.component === 'subtotal'; }) ? (
        <section className="stack" aria-labelledby="quote-adjustments">
          <h4 id="quote-adjustments">{t('builder.adjustments')}</h4>
          <ul className="quote-lines">
            {breakdown.lines.filter((l) => l.component === 'subtotal').map((l) => (
              <li key={l.key}>
                <span>{lineLabel(pkg, breakdown, l)}</span>
                <span>{money(l.amountMinor, l.direction === 'discount' ? '-' : '')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {breakdown.perTraveller.length > 1 ? (
        <section className="stack" aria-labelledby="quote-per-traveller">
          <h4 id="quote-per-traveller">{t('builder.perTravellerHeading')}</h4>
          <ul className="quote-lines">
            {breakdown.perTraveller.map((p) => (
              <li key={p.slot}>
                <span>{t('builder.travellerLabel', { number: p.slot })}</span>
                <span>{money(p.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="field__hint">{t('builder.requestNote')}</p>
    </div>
  );
}
