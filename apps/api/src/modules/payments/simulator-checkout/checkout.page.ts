// The simulator's hosted checkout page (plan 3.6, sections 3.2 and 10.1): plain HTML with no script, no style and no
// input, served behind the web app's /api proxy, which drops the API's security headers. So the page carries its own
// policy in <meta> and the link back never sends the URL (it holds the token) as a referrer. Every interpolated value
// is escaped. Money is formatted from bigint with the currency's digits: no floating point.

export type CheckoutPageState = 'open' | 'paid' | 'declined' | 'finished';

export const CHECKOUT_PAGE_CSP = "default-src 'none'; form-action 'self'; base-uri 'none'";

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

function digitsOf(currency: string): number {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "AUD 1,234.56" from minor units, without floating point. */
export function formatMinor(amountMinor: bigint, currency: string): string {
  const digits = digitsOf(currency);
  const s = (amountMinor < 0n ? -amountMinor : amountMinor).toString().padStart(digits + 1, '0');
  const whole = s.slice(0, s.length - digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = digits > 0 ? `.${s.slice(s.length - digits)}` : '';
  return `${currency} ${amountMinor < 0n ? '-' : ''}${whole}${frac}`;
}

const HEADINGS: Record<CheckoutPageState, string> = {
  open: 'Test payment',
  paid: 'Payment approved',
  declined: 'Payment declined',
  finished: 'This payment is already finished',
};

export function checkoutPage(state: CheckoutPageState, amount: { amountMinor: bigint; currency: string }, returnUrl: string): string {
  const heading = escapeHtml(HEADINGS[state]);
  const form = state === 'open'
    ? `<form method="post">
<p>Choose what the test card does.</p>
<button type="submit" name="outcome" value="pay">Pay (test)</button>
<button type="submit" name="outcome" value="decline">Decline (test)</button>
</form>`
    : '';
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CHECKOUT_PAGE_CSP)}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${heading} – payment simulator</title>
</head>
<body>
<main>
<h1>${heading}</h1>
<p>Payment simulator. Test payment: no real money moves and no card details are asked for.</p>
<p>Amount: <strong>${escapeHtml(formatMinor(amount.amountMinor, amount.currency))}</strong></p>
${form}
<p><a href="${escapeHtml(returnUrl)}" rel="noreferrer">Back to the site</a></p>
</main>
</body>
</html>
`;
}
