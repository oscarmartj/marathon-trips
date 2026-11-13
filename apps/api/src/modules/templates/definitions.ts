import type { TemplateChannelValue } from '@mt/shared';

// The templates the system knows about (task 5.4). Staff edit the wording; the list of keys and of the variables each
// may use lives here, in code, because a variable has to be filled by code that knows where its value comes from.
// `starter` is the wording offered when staff begin a new template; the live defaults stay where they are built (the crm
// emails), and are used whenever no revision is active.

export interface TemplateVariable {
  name: string;
  description: string;
  /** Made-up value for the preview. Never a real customer's. */
  sample: string;
  /** Never in the subject, which is stored with the email and shown in the panel (task 5.1: a payment link's token). */
  bodyOnly?: boolean;
  /** Must be in the body (task 5.1: an email that minted a payment link has to carry it). */
  requiredInBody?: boolean;
}

export interface TemplateDefinition {
  channel: TemplateChannelValue;
  key: string;
  label: string;
  variables: readonly TemplateVariable[];
  starter: { subject: string; body: string };
}

const v = (name: string, description: string, sample: string): TemplateVariable => ({ name, description, sample });

const BRAND = v('brandName', 'The business name', 'Marathon Trips');
const GIVEN = v('givenName', 'The customer’s given name', 'Alex');
const REFERENCE = v('reference', 'The booking or quote reference', 'BK-7QX4MD');
const TRIP = v('trip', 'Race, year and package', 'Sample City Marathon 2027: Marathon weekend');
const TOTAL = v('total', 'The total price as quoted', 'A$2,450.00');
const LINK = v('link', 'Link to the booking or quote page', 'https://example.test/trips/requests/BK-7QX4MD');

const bookingMail = (key: string, label: string, subject: string, lines: string[]): TemplateDefinition => ({
  channel: 'email', key, label, variables: [GIVEN, REFERENCE, TRIP, TOTAL, LINK, BRAND],
  starter: { subject, body: ['Hi {{givenName}},', '', ...lines.flatMap((l) => [l, '']), 'Details: {{link}}', '', '{{brandName}}'].join('\n') },
});

const documentVars = [
  v('customerName', 'The customer’s full name', 'Alex Sample'),
  REFERENCE, TRIP,
  v('departureDate', 'First night of the trip', '10 June 2027'),
  v('returnDate', 'Last day of the trip', '14 June 2027'),
  TOTAL,
  v('itinerary', 'Day-by-day plan, one line per item', 'Thu 10 June: arrive and check in\nFri 11 June: expo and race briefing\nSat 12 June: race day'),
  BRAND,
] as const;

const documentStarter = (title: string, intro: string): { subject: string; body: string } => ({
  subject: title,
  body: [intro, '', 'Booking reference: {{reference}}', 'Traveller: {{customerName}}', 'Trip: {{trip}}', 'Dates: {{departureDate}} to {{returnDate}}', '', '{{brandName}}'].join('\n'),
});

export const TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [
  bookingMail('crm.booking_requested', 'Booking request received', 'We have your booking request {{reference}}', [
    'Thanks for your request for {{trip}}.',
    'This is a booking request, not a confirmed booking, and we have not charged you anything. We will check availability and email you.',
    'Total as quoted: {{total}}.',
  ]),
  bookingMail('crm.booking_approved', 'Booking request approved', 'Your booking request {{reference}} is approved', [
    'Good news: we have approved your request for {{trip}}, and we are holding your places.',
    'Total: {{total}}. We have not charged you anything yet, and the booking is not complete until we write to you about the next steps.',
  ]),
  bookingMail('crm.booking_declined', 'Booking request declined', 'About your booking request {{reference}}', [
    'We are sorry, but we cannot take your request for {{trip}}. We have released the places we were holding and have not charged you anything.',
  ]),
  bookingMail('crm.booking_cancelled', 'Booking request cancelled', 'Your booking request {{reference}} was cancelled', [
    'Your request for {{trip}} has been cancelled and the places we were holding are released.',
  ]),
  bookingMail('crm.booking_expired', 'Booking request expired', 'Your booking request {{reference}} has expired', [
    'We could not review your request for {{trip}} in time, so it has expired and the places we were holding are released. You are welcome to send a new request.',
  ]),
  {
    channel: 'email', key: 'crm.quote_sent', label: 'Quote sent', variables: [GIVEN, REFERENCE, TRIP, TOTAL, v('expiresAt', 'When the quoted price stops being held', '1 December 2026, 5:00 pm'), LINK, BRAND],
    starter: {
      subject: 'Your quote {{reference}}',
      body: ['Hi {{givenName}},', '', 'We have prepared a quote for you: {{trip}}.', '', 'Total: {{total}}. We hold this price until {{expiresAt}} (Brisbane time).', '', 'Accepting it reserves your places and does not take any payment. We will write to you about the next steps.', '', 'Review and accept it here: {{link}}', '', '{{brandName}}'].join('\n'),
    },
  },
  // Task 7.4: emails an automation may send. Customer notices are service messages about the customer's own booking or
  // quote, never promotions, and are not sent to an address on the suppression list. The staff notice goes to the
  // rule's owner and carries no customer name, address or amount.
  ...[1, 2, 3].map((n): TemplateDefinition => ({
    channel: 'email', key: `automations.customer_notice_${n}`,
    label: `Automation customer notice ${n} (service message about their booking or quote, no promotions)`,
    variables: [GIVEN, REFERENCE, TRIP, v('link', 'Link to the customer’s booking or quote page', 'https://example.test/trips/requests/BK-7QX4MD'), BRAND],
    starter: { subject: 'About your booking {{reference}}', body: ['Hi {{givenName}},', '', 'A note about {{trip}}.', '', 'Details: {{link}}', '', '{{brandName}}'].join('\n') },
  })),
  {
    channel: 'email', key: 'automations.staff_notice', label: 'Automation notice to staff (the rule’s owner)',
    variables: [
      v('ruleName', 'The automation’s name', 'New request follow-up'), v('reference', 'The booking or quote reference, if the rule is about one', 'BK-7QX4MD'),
      v('adminLink', 'Link to the record in the panel', 'https://example.test/admin/bookings/0190a1b2-0000-7000-8000-000000000000'), BRAND,
    ],
    starter: { subject: 'Automation: {{ruleName}}', body: ['The automation “{{ruleName}}” ran.', '', 'Record: {{reference}} {{adminLink}}', '', '{{brandName}}'].join('\n') },
  },
  // Task 5.1: the payment link staff send. No amount (the page shows the live one); the link is the token, minted when
  // the email is sent, and must stay in the body.
  {
    channel: 'email', key: 'payments.payment_link', label: 'Payment link (single use, sent by staff)',
    variables: [GIVEN, REFERENCE, TRIP, v('expiresAt', 'When the link stops working (Brisbane time)', '1 December 2026, 5:00 pm'), { ...v('link', 'The single-use payment link (body only, required: it carries a secret token)', 'https://example.test/pay#token=sample'), bodyOnly: true, requiredInBody: true }, BRAND],
    starter: {
      subject: 'Your payment link for booking {{reference}}',
      body: ['Hi {{givenName}},', '', 'Here is a link to make the next payment for your booking {{reference}}: {{trip}}.', '', 'It works once, until {{expiresAt}} (Brisbane time). The page shows the amount due.', '', '{{link}}', '', 'Please do not forward this email: anyone with the link can make this payment.', '', '{{brandName}}'].join('\n'),
    },
  },
  { channel: 'document', key: 'confirmation', label: 'Booking confirmation', variables: documentVars, starter: documentStarter('Booking confirmation', 'This confirms the booking below.') },
  { channel: 'document', key: 'itinerary', label: 'Itinerary', variables: documentVars, starter: { subject: 'Your itinerary', body: ['Your itinerary for {{trip}}.', '', '{{itinerary}}', '', 'Booking reference: {{reference}}', '', '{{brandName}}'].join('\n') } },
  { channel: 'document', key: 'voucher', label: 'Voucher', variables: documentVars, starter: documentStarter('Voucher', 'Show this voucher at check-in.') },
  { channel: 'document', key: 'receipt', label: 'Receipt', variables: documentVars, starter: { subject: 'Receipt', body: ['Receipt for {{trip}}.', '', 'Booking reference: {{reference}}', 'Total: {{total}}', '', '{{brandName}}'].join('\n') } },
];

export function definitionOf(channel: TemplateChannelValue, key: string): TemplateDefinition | undefined {
  return TEMPLATE_DEFINITIONS.find((d) => d.channel === channel && d.key === key);
}

/** The variable rules of a definition, for checkWording. */
export const rulesOf = (d: TemplateDefinition) => ({
  bodyOnly: d.variables.filter((x) => x.bodyOnly).map((x) => x.name),
  requiredInBody: d.variables.filter((x) => x.requiredInBody).map((x) => x.name),
});

export const sampleValues = (d: TemplateDefinition): Record<string, string> => Object.fromEntries(d.variables.map((x) => [x.name, x.sample]));
