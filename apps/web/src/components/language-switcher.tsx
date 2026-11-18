'use client';

import { usePathname } from 'next/navigation';
import { LOCALE_NAMES, splitLocale, type Locale } from '@/lib/locales';

/**
 * Links to the same page in each enabled language. Every link names its language in that language (`lang`), so a screen
 * reader says it correctly. The default language is linked with its explicit tag (`/en-AU/...`): the proxy sends that
 * back to the unprefixed address and remembers the choice.
 */
export function LanguageSwitcher({ locales, current, label }: { locales: readonly Locale[]; current: Locale; label: string }) {
  const { rest } = splitLocale(usePathname() || '/');
  // `/races` -> `/es-ES/races`; the home page is just the tag.
  return (
    <nav aria-label={label} className="language-switcher">
      <ul className="nav-list">
        {locales.map((l) => (
          <li key={l}>
            <a href={l === current ? undefined : `/${l}${rest === '/' ? '' : rest}`} lang={l} hrefLang={l} aria-current={l === current ? 'true' : undefined}>
              {LOCALE_NAMES[l]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
