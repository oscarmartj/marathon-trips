/**
 * The page structure of the web app, in one place. Navigation, the route test and the
 * robots rules all read this table; `labelKey` is a key in messages/en-AU.json.
 * `file` is the page file under src/app (checked by routes.test.ts).
 */
export interface RouteDef {
  path: string;
  file: string;
  labelKey: string;
  /** Shown in the main navigation / admin sidebar. */
  nav?: boolean;
  /** Footer group. */
  footer?: 'company' | 'legal';
}

export const publicRoutes: readonly RouteDef[] = [
  { path: '/', file: '(public)/page.tsx', labelKey: 'nav.home' },
  { path: '/races', file: '(public)/races/page.tsx', labelKey: 'nav.races', nav: true },
  { path: '/races/[slug]', file: '(public)/races/[slug]/page.tsx', labelKey: 'nav.race' },
  { path: '/races/[slug]/build', file: '(public)/races/[slug]/build/page.tsx', labelKey: 'nav.build' },
  { path: '/races/[slug]/request', file: '(public)/races/[slug]/request/page.tsx', labelKey: 'nav.bookingRequest' },
  { path: '/trips/requests/[reference]', file: '(public)/trips/requests/[reference]/page.tsx', labelKey: 'nav.bookingRequestSent' },
  { path: '/quotes/[reference]', file: '(public)/quotes/[reference]/page.tsx', labelKey: 'nav.quote' },
  { path: '/checkout', file: '(public)/checkout/page.tsx', labelKey: 'nav.checkout' },
  { path: '/about', file: '(public)/about/page.tsx', labelKey: 'nav.about', nav: true, footer: 'company' },
  { path: '/pages/[slug]', file: '(public)/pages/[slug]/page.tsx', labelKey: 'nav.page' },
  { path: '/faq', file: '(public)/faq/page.tsx', labelKey: 'nav.faq', nav: true, footer: 'company' },
  { path: '/contact', file: '(public)/contact/page.tsx', labelKey: 'nav.contact', nav: true, footer: 'company' },
  { path: '/legal/terms', file: '(public)/legal/terms/page.tsx', labelKey: 'nav.terms', footer: 'legal' },
  { path: '/legal/privacy', file: '(public)/legal/privacy/page.tsx', labelKey: 'nav.privacy', footer: 'legal' },
  { path: '/legal/complaints', file: '(public)/legal/complaints/page.tsx', labelKey: 'nav.complaints', footer: 'legal' },
  { path: '/alerts/confirm', file: '(public)/alerts/confirm/page.tsx', labelKey: 'nav.alertsConfirm' },
  { path: '/alerts/unsubscribe', file: '(public)/alerts/unsubscribe/page.tsx', labelKey: 'nav.alertsUnsubscribe' },
  { path: '/account', file: '(public)/account/page.tsx', labelKey: 'nav.account' },
  { path: '/account/sign-in', file: '(public)/account/sign-in/page.tsx', labelKey: 'nav.signIn' },
  { path: '/account/sign-in/verify', file: '(public)/account/sign-in/verify/page.tsx', labelKey: 'nav.verifySignIn' },
];

export const adminRoutes: readonly RouteDef[] = [
  { path: '/admin', file: 'admin/(panel)/page.tsx', labelKey: 'admin.nav.dashboard', nav: true },
  { path: '/admin/races', file: 'admin/(panel)/races/page.tsx', labelKey: 'admin.nav.races', nav: true },
  { path: '/admin/races/[id]', file: 'admin/(panel)/races/[id]/page.tsx', labelKey: 'admin.nav.race' },
  { path: '/admin/editions/[id]', file: 'admin/(panel)/editions/[id]/page.tsx', labelKey: 'admin.nav.edition' },
  { path: '/admin/packages', file: 'admin/(panel)/packages/page.tsx', labelKey: 'admin.nav.packages', nav: true },
  { path: '/admin/packages/[id]', file: 'admin/(panel)/packages/[id]/page.tsx', labelKey: 'admin.nav.package' },
  { path: '/admin/packages/[id]/preview', file: 'admin/(panel)/packages/[id]/preview/page.tsx', labelKey: 'admin.nav.packagePreview' },
  { path: '/admin/packages/[id]/prices', file: 'admin/(panel)/packages/[id]/prices/page.tsx', labelKey: 'admin.nav.packagePrices' },
  { path: '/admin/packages/[id]/prices/[versionId]', file: 'admin/(panel)/packages/[id]/prices/[versionId]/page.tsx', labelKey: 'admin.nav.priceVersion' },
  { path: '/admin/pricing', file: 'admin/(panel)/pricing/page.tsx', labelKey: 'admin.nav.pricing', nav: true },
  { path: '/admin/hotels', file: 'admin/(panel)/hotels/page.tsx', labelKey: 'admin.nav.hotels', nav: true },
  { path: '/admin/suppliers', file: 'admin/(panel)/suppliers/page.tsx', labelKey: 'admin.nav.suppliers', nav: true },
  { path: '/admin/suppliers/[id]', file: 'admin/(panel)/suppliers/[id]/page.tsx', labelKey: 'admin.nav.supplier' },
  { path: '/admin/content', file: 'admin/(panel)/content/page.tsx', labelKey: 'admin.nav.content', nav: true },
  { path: '/admin/content/[kind]', file: 'admin/(panel)/content/[kind]/page.tsx', labelKey: 'admin.nav.contentKind' },
  { path: '/admin/bookings', file: 'admin/(panel)/bookings/page.tsx', labelKey: 'admin.nav.bookings', nav: true },
  { path: '/admin/bookings/[id]', file: 'admin/(panel)/bookings/[id]/page.tsx', labelKey: 'admin.nav.booking' },
  { path: '/admin/quotes', file: 'admin/(panel)/quotes/page.tsx', labelKey: 'admin.nav.quotes', nav: true },
  { path: '/admin/quotes/[id]', file: 'admin/(panel)/quotes/[id]/page.tsx', labelKey: 'admin.nav.quote' },
  { path: '/admin/templates', file: 'admin/(panel)/templates/page.tsx', labelKey: 'admin.nav.templates', nav: true },
  { path: '/admin/complaints', file: 'admin/(panel)/complaints/page.tsx', labelKey: 'admin.nav.complaints', nav: true },
  { path: '/admin/complaints/[id]', file: 'admin/(panel)/complaints/[id]/page.tsx', labelKey: 'admin.nav.complaint' },
  { path: '/admin/key-dates', file: 'admin/(panel)/key-dates/page.tsx', labelKey: 'admin.nav.keydates', nav: true },
  { path: '/admin/automations', file: 'admin/(panel)/automations/page.tsx', labelKey: 'admin.nav.automations', nav: true },
  { path: '/admin/automations/[id]', file: 'admin/(panel)/automations/[id]/page.tsx', labelKey: 'admin.nav.automation' },
  { path: '/admin/tasks', file: 'admin/(panel)/tasks/page.tsx', labelKey: 'admin.nav.tasks', nav: true },
  { path: '/admin/customers', file: 'admin/(panel)/customers/page.tsx', labelKey: 'admin.nav.customers', nav: true },
  { path: '/admin/customers/[id]', file: 'admin/(panel)/customers/[id]/page.tsx', labelKey: 'admin.nav.customer' },
  { path: '/admin/settings', file: 'admin/(panel)/settings/page.tsx', labelKey: 'admin.nav.settings', nav: true },
  { path: '/admin/settings/custom-fields', file: 'admin/(panel)/settings/custom-fields/page.tsx', labelKey: 'admin.nav.customFields' },
  { path: '/admin/flags', file: 'admin/(panel)/flags/page.tsx', labelKey: 'admin.nav.flags', nav: true },
  { path: '/admin/integrations', file: 'admin/(panel)/integrations/page.tsx', labelKey: 'admin.nav.integrations', nav: true },
  { path: '/admin/staff', file: 'admin/(panel)/staff/page.tsx', labelKey: 'admin.nav.staff', nav: true },
  { path: '/admin/roles', file: 'admin/(panel)/roles/page.tsx', labelKey: 'admin.nav.roles', nav: true },
  { path: '/admin/sign-in', file: 'admin/(auth)/sign-in/page.tsx', labelKey: 'admin.nav.signIn' },
  { path: '/admin/enrol', file: 'admin/(auth)/enrol/page.tsx', labelKey: 'admin.nav.enrol' },
];
