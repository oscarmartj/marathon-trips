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
  { path: '/checkout', file: '(public)/checkout/page.tsx', labelKey: 'nav.checkout' },
  { path: '/about', file: '(public)/about/page.tsx', labelKey: 'nav.about', nav: true, footer: 'company' },
  { path: '/faq', file: '(public)/faq/page.tsx', labelKey: 'nav.faq', nav: true, footer: 'company' },
  { path: '/contact', file: '(public)/contact/page.tsx', labelKey: 'nav.contact', nav: true, footer: 'company' },
  { path: '/legal/terms', file: '(public)/legal/terms/page.tsx', labelKey: 'nav.terms', footer: 'legal' },
  { path: '/legal/privacy', file: '(public)/legal/privacy/page.tsx', labelKey: 'nav.privacy', footer: 'legal' },
  { path: '/legal/complaints', file: '(public)/legal/complaints/page.tsx', labelKey: 'nav.complaints', footer: 'legal' },
  { path: '/account', file: '(public)/account/page.tsx', labelKey: 'nav.account' },
  { path: '/account/sign-in', file: '(public)/account/sign-in/page.tsx', labelKey: 'nav.signIn' },
  { path: '/account/sign-in/verify', file: '(public)/account/sign-in/verify/page.tsx', labelKey: 'nav.verifySignIn' },
];

export const adminRoutes: readonly RouteDef[] = [
  { path: '/admin', file: 'admin/(panel)/page.tsx', labelKey: 'admin.nav.dashboard', nav: true },
  { path: '/admin/races', file: 'admin/(panel)/races/page.tsx', labelKey: 'admin.nav.races', nav: true },
  { path: '/admin/packages', file: 'admin/(panel)/packages/page.tsx', labelKey: 'admin.nav.packages', nav: true },
  { path: '/admin/bookings', file: 'admin/(panel)/bookings/page.tsx', labelKey: 'admin.nav.bookings', nav: true },
  { path: '/admin/customers', file: 'admin/(panel)/customers/page.tsx', labelKey: 'admin.nav.customers', nav: true },
  { path: '/admin/settings', file: 'admin/(panel)/settings/page.tsx', labelKey: 'admin.nav.settings', nav: true },
  { path: '/admin/flags', file: 'admin/(panel)/flags/page.tsx', labelKey: 'admin.nav.flags', nav: true },
  { path: '/admin/staff', file: 'admin/(panel)/staff/page.tsx', labelKey: 'admin.nav.staff', nav: true },
  { path: '/admin/roles', file: 'admin/(panel)/roles/page.tsx', labelKey: 'admin.nav.roles', nav: true },
  { path: '/admin/sign-in', file: 'admin/(auth)/sign-in/page.tsx', labelKey: 'admin.nav.signIn' },
  { path: '/admin/enrol', file: 'admin/(auth)/enrol/page.tsx', labelKey: 'admin.nav.enrol' },
];

/** Placeholder race used until the API provides races (public pages are statically generated). */
export const placeholderRaceSlugs = ['sample-marathon'] as const;
