import Link from 'next/link';
import { PlaceholderImage } from '@/components/placeholder-image';
import { t } from '@/lib/i18n';

// Public pages are static; this one has no client-side JavaScript of its own.
export default function Home() {
  return (
    <>
      <section className="hero on-night">
        <div className="container hero__grid">
          <div>
            <h1>{t('home.heroHeading')}</h1>
            <p>{t('home.heroBody')}</p>
            <Link className="btn btn--accent" href="/races">
              {t('home.heroCta')}
            </Link>
          </div>
          <PlaceholderImage alt={t('home.imageAlt')} />
        </div>
      </section>
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
