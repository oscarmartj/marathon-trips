import type { Metadata } from 'next';
import { JsonLdScript } from '@/components/json-ld';
import { PageHeader } from '@/components/page-header';
import { Prose } from '@/components/prose';
import { groupFaqs, listFaqs } from '@/lib/content';
import { faqJsonLd, pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

// Questions and answers come from the content manager and are refreshed at most once a minute.
export const revalidate = 60;

export const metadata: Metadata = pageMetadata({ title: t('faqPage.title'), description: t('faqPage.intro'), path: '/faq' });

export default async function Page() {
  const faqs = await listFaqs();
  const groups = groupFaqs(faqs);
  return (
    <>
      {faqs.length > 0 ? <JsonLdScript data={faqJsonLd(faqs)} /> : null}
      <PageHeader title={t('faqPage.title')} intro={t('faqPage.intro')} />
      <div className="container stack">
        {faqs.length === 0 ? <p>{t('faqPage.empty')}</p> : null}
        {groups.map((g, gi) => (
          <section key={g.category || 'general'} className="stack" aria-labelledby={`faq-group-${gi}`}>
            <h2 id={`faq-group-${gi}`}>{g.category || t('faqPage.generalHeading')}</h2>
            {g.items.map((f) => (
              <div key={f.id} className="card stack">
                <h3>{f.question}</h3>
                <Prose text={f.answer} />
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
