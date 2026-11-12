import { t } from './i18n';
import { localisedText, type EditionSummary, type RaceDetail, type RaceSummary } from './catalogue';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const;
export const monthName = (m: number): string => t(`races.months.${MONTHS[m - 1]}`);

/** "12 April 2027" from an ISO calendar date, read in UTC so the day never shifts with the server's zone. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

export function formatDistance(kind: string, metres: number, name: Record<string, string>): string {
  const label = localisedText(name);
  if (label) return label;
  if (kind !== 'other' && kind !== 'ultra') return t(`races.distanceKinds.${kind}`);
  return `${Number((metres / 1000).toFixed(1))} km`;
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en-AU'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** When an edition runs, or that the date is still to be confirmed. `confirmed` is false whenever the API says the date is provisional. */
export function editionDateText(e: Pick<EditionSummary, 'startDate' | 'endDate' | 'dateConfirmed'>): string {
  if (!e.startDate) return t('races.dateNotSet');
  const start = formatDate(e.startDate);
  return e.endDate && e.endDate !== e.startDate ? `${start} to ${formatDate(e.endDate)}` : start;
}

/** The next edition people can still plan for: the soonest not cancelled or completed, else the latest. */
export function nextEdition(race: Pick<RaceSummary, 'editions'>): EditionSummary | undefined {
  const live = race.editions.filter((e) => e.status !== 'cancelled' && e.status !== 'completed');
  return [...live].sort((a, b) => a.year - b.year)[0] ?? race.editions[0];
}

/** True when any edition has a package that is open for booking. The alert form is for the time before that. */
export const hasOpenPackage = (race: Pick<RaceDetail, 'editions'>): boolean => race.editions.some((e) => e.packages.some((p) => p.saleStatus === 'open'));
