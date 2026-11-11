import { t } from '@/lib/i18n';

// Public pages are static; this one has no client-side JavaScript of its own.
export default function Home() {
  return (
    <main>
      <h1>{t('home.title')}</h1>
      <p>{t('home.tagline')}</p>
    </main>
  );
}
