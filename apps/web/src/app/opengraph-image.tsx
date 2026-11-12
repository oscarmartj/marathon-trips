import { brand } from '@mt/shared/brand';
import { SHARE_IMAGE_SIZE, SHARE_IMAGE_TYPE, shareImage } from '@/lib/share-image';
import { t } from '@/lib/i18n';

export const size = SHARE_IMAGE_SIZE;
export const contentType = SHARE_IMAGE_TYPE;
export const alt = t('seo.shareImageAlt', { name: brand.name });

export default function Image() {
  return shareImage(brand.name, t('seo.shareImageTagline'));
}
