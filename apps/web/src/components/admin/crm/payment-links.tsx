'use client';

import { useState } from 'react';
import { Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Section, useLoad } from '../catalogue/kit';
import { crmError, formatMoment } from './crm-kit';

interface LinkRow {
  id: string;
  status: 'active' | 'used' | 'revoked';
  expired: boolean;
  sent: boolean;
  targetSequence: number;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

/**
 * Payment links of a booking (task 5.1): staff send a single-use link for the next item of the plan to the booking's own
 * email address, and can revoke it. The token is never shown here; only the customer's email carries it.
 */
export function PaymentLinksPanel({ bookingId, status }: { bookingId: string; status: string }) {
  const { data, reload } = useLoad<{ links: LinkRow[] }>(`/admin/payments/bookings/${bookingId}`);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  // Without payments.payment.read the panel's section stays hidden (the API says 403).
  if (!data) return null;

  async function run(path: string, done: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api(path, { method: 'POST', body: {} });
      if (r.status === 200 || r.status === 201) {
        setMessage({ text: t(done), tone: 'info' });
        await reload();
      } else setMessage({ text: r.status === 403 ? t('admin.crm.paymentLinks.forbidden') : crmError(r), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const payable = ['approved', 'deposit_paid', 'confirmed'].includes(status);
  const state = (l: LinkRow) => (l.status === 'active' && l.expired ? 'expired' : l.status === 'active' && !l.sent ? 'queued' : l.status);
  return (
    <Section id="booking-payment-links" title={t('admin.crm.paymentLinks.title')}>
      <p>{t('admin.crm.paymentLinks.intro')}</p>
      {data.links.length === 0 ? <p>{t('admin.crm.paymentLinks.none')}</p> : (
        <ul>
          {data.links.map((l) => (
            <li key={l.id}>
              {t('admin.crm.paymentLinks.row', { state: t(`admin.crm.paymentLinks.states.${state(l)}`), item: l.targetSequence, created: formatMoment(l.createdAt), expires: formatMoment(l.expiresAt) })}
              {l.status === 'active' && !l.expired ? (
                <>
                  {' '}
                  <button className="link-button" type="button" disabled={busy} onClick={() => void run(`/admin/payments/payment-links/${l.id}/revoke`, 'admin.crm.paymentLinks.revoked')}>{t('admin.crm.paymentLinks.revoke')}</button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {payable ? <p><button className="btn" type="button" disabled={busy} onClick={() => void run(`/admin/payments/bookings/${bookingId}/payment-links`, 'admin.crm.paymentLinks.sent')}>{t('admin.crm.paymentLinks.send')}</button></p> : null}
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
    </Section>
  );
}
