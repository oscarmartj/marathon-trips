import type { Metadata } from 'next';
import { JsonLdScript } from '@/components/json-ld';
import { PageHeader } from '@/components/page-header';
import { Prose } from '@/components/prose';
import { groupFaqs, listFaqs, localesWithContent } from '@/lib/content';
import { faqJsonLd, pageMetadata } from '@/lib/seo';
import { localeFromParams } from '@/lib/locale-server';
import { t } from '@/lib/i18n';

// Questions and answers come from the content manager and are refreshed at most once a minute.
export const revalidate = 60;

type Props = { params?: Promise<{ locale?: string }> };

// The page is listed in a language's `hreflang` set only for languages that have published questions.
export async function generateMetadata({ params }: Props = {}): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return pageMetadata({ title: t('faqPage.title'), description: t('faqPage.intro'), path: '/faq', locale, locales: await localesWithContent(async (l) => (await listFaqs(l)).length > 0) });
}

export default async function Page({ params }: Props = {}) {
  await localeFromParams(params);
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
