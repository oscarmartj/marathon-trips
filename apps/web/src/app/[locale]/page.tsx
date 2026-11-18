import Link from 'next/link';
import type { Metadata } from 'next';
import { PlaceholderImage } from '@/components/placeholder-image';
import { RaceCard } from '@/components/catalogue/race-card';
import { searchRaces, type RaceSummary } from '@/lib/catalogue';
import { pageMetadata } from '@/lib/seo';
import { localeFromParams } from '@/lib/locale-server';
import { lp, t } from '@/lib/i18n';
import { brand } from '@mt/shared/brand';

// Built ahead and refreshed at most once a minute. The only script on the page is the framework's.
export const revalidate = 60;

type Props = { params?: Promise<{ locale?: string }> };

export async function generateMetadata({ params }: Props = {}): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return pageMetadata({ title: brand.name, description: t('home.tagline'), path: '/', locale });
}

async function featuredRaces(): Promise<RaceSummary[]> {
  try {
    return (await searchRaces({})).items.slice(0, 3);
  } catch {
    return []; // the home page still works when the catalogue is unreachable
  }
}

export default async function Home({ params }: Props = {}) {
  await localeFromParams(params);
  const featured = await featuredRaces();
  return (
    <>
      <section className="hero on-night">
        <div className="container hero__grid">
          <div className="stack">
            <h1>{t('home.heroHeading')}</h1>
            <p>{t('home.heroBody')}</p>
            <form method="get" action={lp('/races')} role="search" className="hero__search">
              <label htmlFor="home-q">{t('home.searchLabel')}</label>
              <input id="home-q" name="q" type="search" maxLength={80} />
              <button className="btn btn--accent" type="submit">
                {t('home.searchButton')}
              </button>
            </form>
            <Link className="btn btn--accent" href={lp('/races')}>
              {t('home.heroCta')}
            </Link>
          </div>
          <PlaceholderImage alt={t('home.imageAlt')} />
        </div>
      </section>
      {featured.length > 0 ? (
        <section className="section container stack" aria-labelledby="featured-heading">
          <h2 id="featured-heading">{t('home.upcomingHeading')}</h2>
          <p>{t('home.upcomingIntro')}</p>
          <div className="grid grid--3">
            {featured.map((race) => (
              <RaceCard key={race.slug} race={race} />
            ))}
          </div>
          <p>
            <Link className="link-block" href={lp('/races')}>{t('home.seeAll')}</Link>
          </p>
        </section>
      ) : null}
      <section className="section container" aria-labelledby="steps-heading">
        <h2 id="steps-heading">{t('home.stepsHeading')}</h2>
        <div className="grid grid--3">
          {[1, 2, 3].map((n) => (
            <div className="card" key={n}>
              <h3>{t(`home.step${n}Title`)}</h3>
              <p>{t(`home.step${n}Body`)}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
