import { AuthFrame } from '@/components/auth-frame';
import { StaffSignInForm } from '@/components/auth/staff-sign-in-form';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AuthFrame title={t('auth.staff.signInTitle')} intro={t('auth.staff.signInIntro')}>
      <StaffSignInForm />
    </AuthFrame>
  );
}
