import { t } from '@/lib/i18n';

/** Shown wherever an edition's date is not yet confirmed. Text, not colour alone, carries the meaning. */
export function DateNotice({ confirmed }: { confirmed: boolean }) {
  if (confirmed) return null;
  return (
    <p className="notice" role="note">
      {t('races.dateUnconfirmed')}
    </p>
  );
}
