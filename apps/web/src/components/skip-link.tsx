import { t } from '@/lib/i18n';

export function SkipLink() {
  return (
    <a className="skip-link" href="#main">
      {t('common.skipToContent')}
    </a>
  );
}
