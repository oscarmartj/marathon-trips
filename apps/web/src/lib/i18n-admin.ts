// Task 6.6: the staff panel's copy. It is a separate file so the public pages' JavaScript does not carry it (the budget in
// e2e/public-site-quality.spec.ts). Every panel module imports `t` from here, never from `./i18n`, so the tree is registered
// before any `t()` call in that module runs. Public modules must not import this file (src/lib/i18n-admin.test.ts).
import enAUAdmin from '../../messages/en-AU.admin.json';
import { registerMessages } from './i18n';

registerMessages('en-AU', enAUAdmin);

export { t, lp, currentLocale, messageCatalogue } from './i18n';
export type { Locale } from './i18n';
