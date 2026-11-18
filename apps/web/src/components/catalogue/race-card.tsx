import Link from 'next/link';
import { editionDateText, countryName, formatDistance, monthName, nextEdition } from '@/lib/catalogue-format';
import { localisedText, type RaceSummary } from '@/lib/catalogue';
import { lp, t } from '@/lib/i18n';
import { DateNotice } from './date-notice';

/** One race in a list. Claim badges are exactly the claims the API reports as switched on for this race. */
export function RaceCard({ race, headingLevel = 3 }: { race: RaceSummary; headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  const edition = nextEdition(race);
  const name = localisedText(race.name);
  return (
    <article className="card stack race-card">
      <Heading>
        <Link href={lp(`/races/${race.slug}`)}>{name}</Link>
      </Heading>
      <p>{t('races.location', { city: race.city, country: countryName(race.countryCode) })}</p>
      {race.distances.length > 0 ? (
        <ul className="chips" aria-label={t('races.distancesLabel')}>
          {race.distances.map((d) => (
            <li key={d.id}>{formatDistance(d.kind, d.distanceMetres, d.name)}</li>
          ))}
        </ul>
      ) : null}
      {edition ? (
        <p>
          {t('races.nextEdition', { year: edition.year, date: editionDateText(edition) })}
        </p>
      ) : race.typicalMonth ? (
        <p>{t('races.usuallyIn', { month: monthName(race.typicalMonth) })}</p>
      ) : null}
      {edition ? <DateNotice confirmed={edition.dateConfirmed} /> : null}
      {race.claims.length > 0 ? (
        <ul className="chips" aria-label={t('races.claimsLabel')}>
          {race.claims.map((c) => (
            <li key={c}>{t(`races.claims.${c}`)}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
