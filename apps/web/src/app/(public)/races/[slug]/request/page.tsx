import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BookingRequestForm } from '@/components/booking/request-form';
import { PageHeader } from '@/components/page-header';
import { builderToSearch, parseBuilderParams } from '@/lib/builder';
import { getPackage, localisedText } from '@/lib/catalogue';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';

export const metadata: Metadata = { title: t('bookingRequest.title'), robots: { index: false, follow: false } };

/** The request page (task 2.4): the builder's configuration from the address, the price from the API, and the contact form. */
export default async function RequestPage({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const year = Number(one(sp.edition));
  const packageSlug = one(sp.package);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !/^[a-z0-9-]{1,100}$/.test(packageSlug) || !/^[a-z0-9-]{1,100}$/.test(slug)) notFound();
  const pkg = await getPackage(slug, year, packageSlug);
  if (!pkg) notFound();
  const state = parseBuilderParams(pkg, sp);
  const query = `edition=${year}&package=${encodeURIComponent(packageSlug)}&${builderToSearch(state)}`;
  const back = (
    <p>
      <Link href={`/races/${slug}/build?${query}`}>{t('bookingRequest.backToBuilder')}</Link>
    </p>
  );
  return (
    <>
      <PageHeader title={t('bookingRequest.title')} intro={localisedText(pkg.name)} />
      <div className="container stack section">
        {pkg.saleStatus === 'open' ? <BookingRequestForm pkg={pkg} state={state} here={`/races/${slug}/request?${query}`} /> : <p>{t('builder.notOpenBody')}</p>}
        {back}
      </div>
    </>
  );
}
