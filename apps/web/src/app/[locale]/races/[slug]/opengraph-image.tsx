import { brand } from '@mt/shared/brand';
import { localisedText, getRace } from '@/lib/catalogue';
import { countryName } from '@/lib/catalogue-format';
import { SHARE_IMAGE_SIZE, SHARE_IMAGE_TYPE, shareImage } from '@/lib/share-image';
import { localeFromParams } from '@/lib/locale-server';
import { t } from '@/lib/i18n';

export const revalidate = 60;
export const size = SHARE_IMAGE_SIZE;
export const contentType = SHARE_IMAGE_TYPE;
export const alt = t('seo.shareImageAlt', { name: brand.name });

// A share image per race: its name and place on the brand background. Unknown or unreadable races fall back to the brand image.
export default async function Image({ params }: { params: Promise<{ locale?: string; slug: string }> }) {
  await localeFromParams(params);
  const race = await getRace((await params).slug).catch(() => null);
  if (!race) return shareImage(brand.name, t('seo.shareImageTagline'));
  return shareImage(localisedText(race.name), t('seo.shareImageRaceLine', { city: race.city, country: countryName(race.countryCode) }));
}
