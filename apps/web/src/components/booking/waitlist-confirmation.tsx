'use client';

import { useEffect, useRef } from 'react';
import { localisedText } from '@/lib/catalogue';
import { t } from '@/lib/i18n';
import type { WaitlistJoined } from '@/lib/booking-request';

/**
 * What the person sees after joining the waiting list (task 2.6): first and plainly, that they are on a waiting list and
 * that this is not a booking request or a booking, and that nothing has been charged. No price, no place in the queue,
 * and no promise that a place will come up.
 */
export function WaitlistConfirmation({ joined }: { joined: WaitlistJoined }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="notice stack" role="status">
      <h2 ref={heading} tabIndex={-1}>
        {t('waitlist.heading')}
      </h2>
      <p>{t('waitlist.notABooking', { name: localisedText(joined.package.name) })}</p>
      <p>{t('waitlist.nothingCharged')}</p>
      <p>{t('waitlist.next')}</p>
    </div>
  );
}
