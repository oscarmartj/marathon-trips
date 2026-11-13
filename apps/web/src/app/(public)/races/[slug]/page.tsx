import { RaceBeacon } from '@/components/race-beacon';
import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlertForm } from '@/components/alerts/alert-form';
import { DateNotice } from '@/components/catalogue/date-notice';
import { ContentImage } from '@/components/content-image';
import { PageHeader } from '@/components/page-header';
import { Prose } from '@/components/prose';
import { PlaceholderImage } from '@/components/placeholder-image';
import { countryName, editionDateText, formatDate, formatDistance, hasOpenPackage, monthName } from '@/lib/catalogue-format';
import { getRace, listRaceSlugs, localisedText } from '@/lib/catalogue';
import { getGuide } from '@/lib/content';
import { JsonLdScript } from '@/components/json-ld';
import { breadcrumbJsonLd, pageMetadata, raceDescription, raceEventsJsonLd } from '@/lib/seo';
import { t } from '@/lib/i18n';

// Built ahead for the races known at deploy time, and on first request for new ones; refreshed at most once a minute.
export const revalidate = 60;
export async function generateStaticParams() {
  return (await listRaceSlugs()).map((slug) => ({ slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = (await params).slug;
  const [race, guide] = await Promise.all([getRace(slug), getGuide(slug)]);
  return race
    ? pageMetadata({ title: guide?.seoTitle || localisedText(race.name), description: guide?.seoDescription || raceDescription(race), path: `/races/${race.slug}` })
    : { title: t('races.detail.notFoundTitle'), robots: { index: false } };
}

export default async function RacePage({ params }: Props) {
  const { slug } = await params;
  const [race, guide] = await Promise.all([getRace(slug), getGuide(slug)]);
  if (!race) notFound();
  const name = localisedText(race.name);
  const summary = localisedText(race.summary);
  // The alert is for people who cannot book yet: it goes away once a package is open.
  const anyOpen = hasOpenPackage(race);
  return (
    <>
      <RaceBeacon raceSlug={race.slug} kind="view" />
      <JsonLdScript
        data={[
          breadcrumbJsonLd([
            { name: t('nav.home'), path: '/' },
            { name: t('nav.races'), path: '/races' },
            { name, path: `/races/${race.slug}` },
          ]),
          ...raceEventsJsonLd(race),
        ]}
      />
      <PageHeader title={t('races.detail.title', { name })} intro={t('races.location', { city: race.city, country: countryName(race.countryCode) })} />
      <div className="container grid grid--2">
        {guide?.heroMedia ? <ContentImage media={guide.heroMedia} /> : <PlaceholderImage alt={t('races.detail.imageAlt')} />}
        <section className="stack" aria-labelledby="guide-heading">
          <h2 id="guide-heading">{t('races.detail.guideHeading')}</h2>
          {summary ? <p>{summary}</p> : null}
          {race.typicalMonth ? <p>{t('races.detail.typicalMonth', { month: monthName(race.typicalMonth) })}</p> : null}
          {race.claims.length > 0 ? (
            <ul className="chips" aria-label={t('races.claimsLabel')}>
              {race.claims.map((c) => (
                <li key={c}>{t(`races.claims.${c}`)}</li>
              ))}
            </ul>
          ) : null}
          {race.distances.length > 0 ? (
            <>
              <h3>{t('races.detail.distancesHeading')}</h3>
              <ul>
                {race.distances.map((d) => (
                  <li key={d.id}>{formatDistance(d.kind, d.distanceMetres, d.name)}</li>
                ))}
              </ul>
            </>
          ) : null}
          {/* The guide sections come from the content manager; a section staff have not written shows the general wording. */}
          {guide?.course ? (
            <>
              <h3>{t('races.detail.courseHeading')}</h3>
              <Prose text={guide.course} />
            </>
          ) : null}
          {guide?.climate ? (
            <>
              <h3>{t('races.detail.climateHeading')}</h3>
              <Prose text={guide.climate} />
            </>
          ) : null}
          <h3>{t('races.detail.entryHeading')}</h3>
          {guide?.entry ? <Prose text={guide.entry} /> : <p>{t('races.detail.entryBody')}</p>}
          <h3>{t('races.detail.travelHeading')}</h3>
          {guide?.travelTips ? <Prose text={guide.travelTips} /> : <p>{t('races.detail.travelBody')}</p>}
          {race.websiteUrl ? (
            <p>
              <a href={race.websiteUrl} rel="noopener noreferrer">
                {t('races.detail.website')}
              </a>
            </p>
          ) : null}
        </section>
      </div>
      {anyOpen ? null : (
        <section className="container stack section" aria-labelledby="alert-heading">
          <h2 id="alert-heading">{t('alerts.heading')}</h2>
          <p>{t('alerts.intro')}</p>
          <AlertForm raceSlug={race.slug} />
        </section>
      )}
      <div className="container stack section" aria-labelledby="editions-heading">
        <h2 id="editions-heading">{t('races.detail.editionsHeading')}</h2>
        {race.editions.map((e) => (
          <section key={e.year} className="card stack" aria-labelledby={`edition-${e.year}`}>
            <h3 id={`edition-${e.year}`}>{t('races.detail.editionHeading', { year: e.year })}</h3>
            <p>{editionDateText(e)}</p>
            <DateNotice confirmed={e.dateConfirmed} />
            {e.status === 'cancelled' || e.status === 'completed' ? <p>{t('races.detail.editionStatus', { status: t(`races.detail.editionStatuses.${e.status}`) })}</p> : null}
            {localisedText(e.notes) ? <p>{localisedText(e.notes)}</p> : null}
            {e.packages.length === 0 ? (
              <p>{t('races.detail.noPackages')}</p>
            ) : (
              <ul className="stack package-list">
                {e.packages.map((p) => (
                  <li key={p.id} className="stack">
                    <h4>{localisedText(p.name)}</h4>
                    <p>{t('races.detail.packageDates', { checkIn: formatDate(p.checkInDate), checkOut: formatDate(p.checkOutDate) })}</p>
                    <ul className="chips" aria-label={t('races.detail.saleStatusLabel')}>
                      <li>{t(`races.detail.saleStatuses.${p.saleStatus}`)}</li>
                      {/* Only when the API says so: the race claim is on and every entry stock is confirmed by the supplier. */}
                      {p.guaranteedEntry ? <li>{t('races.guaranteedEntry')}</li> : null}
                    </ul>
                    {p.saleStatus === 'open' ? (
                      <Link className="btn" href={`/races/${race.slug}/build?edition=${e.year}&package=${encodeURIComponent(p.slug)}`}>
                        {t('races.detail.buildCta')}
                      </Link>
                    ) : p.saleStatus === 'waitlist' || p.saleStatus === 'sold_out' ? (
                      <Link className="btn" href={`/races/${race.slug}/build?edition=${e.year}&package=${encodeURIComponent(p.slug)}`}>
                        {t('races.detail.joinWaitlistCta')}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
