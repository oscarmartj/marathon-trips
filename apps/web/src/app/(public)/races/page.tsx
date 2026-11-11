import Link from 'next/link';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { placeholderRaceSlugs } from '@/lib/routes';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('races.title') };

const filters = ['filterDistance', 'filterMonth', 'filterCountry', 'filterPrice', 'filterEntry', 'filterStatus'] as const;

export default function Races() {
  return (
    <>
      <PageHeader title={t('races.title')} intro={t('races.intro')} />
      <div className="container grid grid--2">
        <section aria-labelledby="filters-heading" className="card">
          <h2 id="filters-heading">{t('races.filtersHeading')}</h2>
          <ul>
            {filters.map((f) => (
              <li key={f}>{t(`races.${f}`)}</li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="sample-heading" className="card">
          <h2 id="sample-heading">{t('races.sampleHeading')}</h2>
          <p>
            <Link href={`/races/${placeholderRaceSlugs[0]}`}>{t('races.sampleLink')}</Link>
          </p>
        </section>
      </div>
    </>
  );
}
