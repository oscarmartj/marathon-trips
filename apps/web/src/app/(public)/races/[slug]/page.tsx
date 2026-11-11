import Link from 'next/link';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { PlaceholderImage } from '@/components/placeholder-image';
import { placeholderRaceSlugs } from '@/lib/routes';
import { t } from '@/lib/i18n';

// Statically generated; once races come from the API this becomes incremental (revalidate).
export function generateStaticParams() {
  return placeholderRaceSlugs.map((slug) => ({ slug }));
}
export const dynamicParams = false;

export const metadata: Metadata = { title: t('races.detail.sampleName') };

export default async function RacePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <>
      <PageHeader title={t('races.detail.title', { name: t('races.detail.sampleName') })} intro={t('races.detail.intro')} />
      <div className="container grid grid--2">
        <PlaceholderImage alt={t('races.detail.imageAlt')} />
        <div className="stack">
          <h2>{t('races.detail.guideHeading')}</h2>
          <p>{t('common.comingSoon')}</p>
          <h2>{t('races.detail.editionsHeading')}</h2>
          <Link className="btn" href={`/races/${slug}/build`}>
            {t('races.detail.buildCta')}
          </Link>
        </div>
      </div>
    </>
  );
}
