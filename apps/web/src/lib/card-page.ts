// The card page of a card session (task 4.4, plan docs/plans/4.4-au-card-gateway.md, section 10.2). Types only come from
// @mt/shared, so the validation library stays out of the browser bundle. The page shows the amount the API returns and
// posts only the gateway's single-use card token; card details exist only inside the gateway's iframes.
import type { CardSessionFailure } from '@mt/shared';

/** The same shape as CARD_SESSION_REF_PATTERN in @mt/shared (a test keeps them equal). */
export const CARD_SESSION_REF = /^cs_[0-9a-f]{32}$/;

/** The four empty containers the gateway's script fills with its iframes. Never an input of ours. */
export const CARD_FIELD_CONTAINERS = [
  { id: 'card-name', field: 'name', label: 'cardPage.fields.name' },
  { id: 'card-number', field: 'number', label: 'cardPage.fields.number' },
  { id: 'card-expiry', field: 'expiry', label: 'cardPage.fields.expiry' },
  { id: 'card-cvc', field: 'cvc', label: 'cardPage.fields.cvc' },
] as const;

/** The only body the page sends with a card: the session reference and the token. */
export function cardSubmitBody(ref: string, cardToken: string): { ref: string; cardToken: string } {
  return { ref, cardToken };
}

/** Message key (under cardPage.errors) for an answer of the card-session routes. */
export function cardPageErrorKey(status: number, code: string | undefined): string {
  if (status === 404) return 'notFound';
  if (status === 409) return code === 'booking_payment_under_review' ? 'underReview' : 'notOpen';
  if (status === 422) return 'invalid';
  if (status === 429) return 'tooMany';
  return 'generic';
}

/** Message key (under cardPage.failed) for why a session ended without money. */
export function cardPageFailureKey(code: CardSessionFailure | undefined): string {
  if (code === 'card_declined' || code === 'insufficient_funds' || code === 'expired_card' || code === 'suspected_fraud') return 'declined';
  if (code === 'card_not_authenticated') return 'notAuthenticated';
  if (code === 'provider_busy') return 'busy';
  return 'generic';
}

/** Loads the gateway's hosted-fields script once; resolves when it has run. Only an https URL is ever loaded. */
export function loadScriptOnce(src: string, given?: Document): Promise<void> {
  if (!/^https:\/\/[a-z0-9.-]+\/[^\s"'<>]*$/.test(src)) return Promise.reject(new Error('script url'));
  const doc = given ?? document;
  const existing = doc.querySelector<HTMLScriptElement>(`script[data-card-fields="1"]`);
  if (existing?.dataset.loaded === '1') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = existing ?? doc.createElement('script');
    s.addEventListener('load', () => {
      s.dataset.loaded = '1';
      resolve();
    });
    s.addEventListener('error', () => reject(new Error('script load')));
    if (!existing) {
      // Inserted by the page's own (nonced) code: 'strict-dynamic' trusts it; the host is in script-src for older browsers.
      s.src = src;
      s.async = true;
      s.dataset.cardFields = '1';
      doc.head.appendChild(s);
    }
  });
}
