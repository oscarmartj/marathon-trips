// eWAY's card page (task 9.1, plan docs/plans/9.1-eway.md, sections 6.3, 6.4 and 10.2). Types only come from @mt/shared,
// so the validation library stays out of the browser bundle. The page posts only eWAY's single-use Secure Fields code
// and, after the bank's check, the access code; card details exist only inside eWAY's iframes. The eWAY script calls
// (`eWAY.setupSecureField`, `Cerberus.run`) are UNVERIFIED until the sandbox run.

/** The four empty containers eWAY's script fills with its iframes (its field types). Never an input of ours. */
export const SECURE_FIELD_CONTAINERS = [
  { id: 'eway-name', fieldType: 'name', label: 'cardPage.fields.name' },
  { id: 'eway-card', fieldType: 'card', label: 'cardPage.fields.number' },
  { id: 'eway-expiry', fieldType: 'expiry', label: 'cardPage.fields.expiry' },
  { id: 'eway-cvn', fieldType: 'cvn', label: 'cardPage.fields.cvc' },
] as const;

/** The same shapes as SECURE_FIELD_CODE_PATTERN and ACCESS_CODE_PATTERN in @mt/shared (a test keeps them equal). */
export const SECURE_FIELD_CODE = /^[A-Za-z0-9_-]{10,512}$/;
export const ACCESS_CODE = /^[A-Za-z0-9_-]{10,512}$/;

/** The only body sent with a card: the session reference and eWAY's code. */
export function secureSubmitBody(ref: string, secureFieldCode: string): { ref: string; secureFieldCode: string } {
  return { ref, secureFieldCode };
}

/** After the bank's check: the session, the access code eWAY gave, and the same code (the API checks it is the same card). */
export function secureAuthoriseBody(ref: string, accessCode: string, secureFieldCode: string): { ref: string; accessCode: string; secureFieldCode: string } {
  return { ref, accessCode, secureFieldCode };
}

/** Message key (under cardPage.errors) for an answer of the Secure Fields routes. */
export function secureFieldsErrorKey(status: number, code: string | undefined): string {
  if (status === 409 && code === 'card_session_phone_required') return 'phoneRequired';
  if (status === 404) return 'notFound';
  if (status === 409) return code === 'booking_payment_under_review' ? 'underReview' : 'notOpen';
  if (status === 422 || status === 400) return 'invalid';
  if (status === 429) return 'tooMany';
  return 'generic';
}
