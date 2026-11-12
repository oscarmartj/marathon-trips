import Link from 'next/link';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { RaceCard } from '@/components/catalogue/race-card';
import { RaceFiltersForm } from '@/components/catalogue/race-filters';
import { CatalogueUnavailableError, PAGE_SIZE, listCountryCodes, parseFilters, racesHref, searchRaces, type RaceSearchResult } from '@/lib/catalogue';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

// Filtered and paged results are thin variants of the same list: they point at /races and ask not to be indexed.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const filters = parseFilters(await searchParams);
  const base = pageMetadata({ title: t('races.title'), description: t('races.intro'), path: '/races' });
  return Object.keys(filters).length > 0 ? { ...base, robots: { index: false, follow: true } } : base;
}

// The filters are in the URL, so this page is rendered per request; the catalogue data behind it is cached for a minute.
export const revalidate = 60;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Races({ searchParams }: Props) {
  const filters = parseFilters(await searchParams);
  const thisYear = new Date().getUTCFullYear();
  const years = [thisYear, thisYear + 1, thisYear + 2];
  let result: RaceSearchResult | null = null;
  try {
    result = await searchRaces(filters);
  } catch (e) {
    if (!(e instanceof CatalogueUnavailableError)) throw e;
  }
  const countries = await listCountryCodes(filters.country);
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const page = filters.page ?? 1;
  return (
    <>
      <PageHeader title={t('races.title')} intro={t('races.intro')} />
      <div className="container finder">
        <RaceFiltersForm filters={filters} countries={countries} years={years} />
        <section aria-labelledby="results-heading" className="stack">
          <h2 id="results-heading">{t('races.resultsHeading')}</h2>
          {result === null ? (
            <p className="notice" role="alert">
              {t('races.unavailable')}
            </p>
          ) : (
            <>
              <p aria-live="polite">{result.total === 1 ? t('races.resultsCountOne') : t('races.resultsCount', { count: result.total })}</p>
              {result.items.length === 0 ? <p>{t('races.noResults')}</p> : null}
              <div className="grid grid--2">
                {result.items.map((race) => (
                  <RaceCard key={race.slug} race={race} />
                ))}
              </div>
              {pages > 1 ? (
                <nav aria-label={t('races.pagination')} className="pager">
                  {page > 1 ? <Link href={racesHref({ ...filters, page: page - 1 })}>{t('races.previousPage')}</Link> : null}
                  <span>{t('races.pageOf', { page, pages })}</span>
                  {page < pages ? <Link href={racesHref({ ...filters, page: page + 1 })}>{t('races.nextPage')}</Link> : null}
                </nav>
              ) : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}
