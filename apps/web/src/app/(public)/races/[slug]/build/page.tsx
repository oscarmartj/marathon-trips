import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PackageBuilder } from '@/components/builder/package-builder';
import { PageHeader } from '@/components/page-header';
import { parseBuilderParams } from '@/lib/builder';
import { getPackage, localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';

/** The package named by the address (`?edition=2027&package=classic`), or null if the address does not name a real one. */
async function load({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const year = Number(one(sp.edition));
  const packageSlug = one(sp.package);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !/^[a-z0-9-]{1,100}$/.test(packageSlug)) return null;
  const pkg = await getPackage(slug, year, packageSlug);
  return pkg ? { pkg, slug, year, packageSlug, sp } : null;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const found = await load(props);
  return { title: found ? t('builder.packageHeading', { package: localisedText(found.pkg.name) }) : t('builder.unavailableTitle'), robots: { index: false } };
}

// The page reads the address, so it is rendered per request; the package itself is cached for a minute like the rest of the catalogue.
export default async function Build(props: Props) {
  const found = await load(props);
  if (!found) notFound();
  const { pkg, slug, year, packageSlug, sp } = found;
  const name = localisedText(pkg.name);
  const back = (
    <p>
      <Link href={`/races/${slug}`}>{t('builder.backToRace')}</Link>
    </p>
  );
  const joinable = pkg.saleStatus === 'waitlist' || pkg.saleStatus === 'sold_out';
  if (pkg.saleStatus !== 'open' && !joinable) {
    return (
      <>
        <PageHeader title={t('builder.notOpenTitle')} intro={name} />
        <div className="container stack section">
          <p>{t('builder.notOpenBody')}</p>
          {back}
        </div>
      </>
    );
  }
  const hasRooms = pkg.hotels.some((h) => h.rooms.length > 0);
  return (
    <>
      <PageHeader title={t('builder.packageHeading', { package: name })} intro={t('builder.datesLine', { checkIn: formatDate(pkg.checkInDate), checkOut: formatDate(pkg.checkOutDate), nights: pkg.nights })} />
      <div className="container stack section">
        <p>{t(joinable ? 'builder.waitlistIntro' : 'races.build.intro')}</p>
        {pkg.guaranteedEntry ? <p className="chips">{t('races.guaranteedEntry')}</p> : null}
        {hasRooms ? (
          <>
            <noscript>
              <p className="notice">{t('builder.needsScript')}</p>
            </noscript>
            <PackageBuilder pkg={pkg} initial={parseBuilderParams(pkg, sp)} urlBase={`?edition=${year}&package=${encodeURIComponent(packageSlug)}`} />
          </>
        ) : (
          <p className="notice">{t('builder.noRooms')}</p>
        )}
        {back}
      </div>
    </>
  );
}
