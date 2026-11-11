import { AuthFrame } from '@/components/auth-frame';
import { EnrolForm } from '@/components/auth/enrol-form';
import { t } from '@/lib/i18n';

export default function Page() {
  return (
    <AuthFrame title={t('auth.enrol.title')} intro={t('auth.enrol.intro')}>
      <EnrolForm />
    </AuthFrame>
  );
}
