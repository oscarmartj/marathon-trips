'use client';

import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';

export function SignOutButton() {
  async function signOut() {
    await api('/auth/staff/sign-out', { method: 'POST', body: {} });
    window.location.assign('/admin/sign-in');
  }
  return (
    <button type="button" className="btn btn--accent" onClick={signOut}>
      {t('admin.nav.signOut')}
    </button>
  );
}
