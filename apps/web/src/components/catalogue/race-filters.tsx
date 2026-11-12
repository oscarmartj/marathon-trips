import Link from 'next/link';
import { countryName, monthName } from '@/lib/catalogue-format';
import { DISTANCE_KINDS, RACE_TYPES, type RaceFilters } from '@/lib/catalogue';
import { t } from '@/lib/i18n';

/**
 * The race finder form. A plain GET form: the filters live in the web address, work without JavaScript, are combined,
 * can be shared and survive a reload. Submitting always goes back to the first page of results.
 */
export function RaceFiltersForm({ filters, countries, years }: { filters: RaceFilters; countries: string[]; years: number[] }) {
  const select = (name: string, label: string, options: Array<[string, string]>) => (
    <div className="field">
      <label htmlFor={`filter-${name}`}>{label}</label>
      <select id={`filter-${name}`} name={name} defaultValue={filters[name as keyof RaceFilters] as string | undefined ?? ''}>
        <option value="">{t('races.anyOption')}</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <form method="get" action="/races" className="card filters" aria-labelledby="filters-heading">
      <h2 id="filters-heading">{t('races.filtersHeading')}</h2>
      <div className="field">
        <label htmlFor="filter-q">{t('races.filterSearch')}</label>
        <input id="filter-q" name="q" type="search" maxLength={80} defaultValue={filters.q ?? ''} />
      </div>
      {select('distance', t('races.filterDistance'), DISTANCE_KINDS.map((k) => [k, t(`races.distanceKinds.${k}`)]))}
      {select('type', t('races.filterType'), RACE_TYPES.map((k) => [k, t(`races.raceTypes.${k}`)]))}
      {select('month', t('races.filterMonth'), Array.from({ length: 12 }, (_, i) => [String(i + 1), monthName(i + 1)]))}
      {select('year', t('races.filterYear'), years.map((y) => [String(y), String(y)]))}
      {select('country', t('races.filterCountry'), countries.map((c) => [c, countryName(c)]))}
      <div className="filters__actions">
        <button className="btn" type="submit">
          {t('races.applyFilters')}
        </button>
        <Link href="/races">{t('races.clearFilters')}</Link>
      </div>
    </form>
  );
}
