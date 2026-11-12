import Link from 'next/link';
import { isExternalHref, type MenuItem } from '@/lib/content';
import { t } from '@/lib/i18n';

/** A list of links from the content manager (or the built-in defaults). Outside addresses open as ordinary links with a hint for screen readers. */
export function MenuLinks({ items, current }: { items: readonly MenuItem[]; current?: string }) {
  return (
    <ul className="nav-list">
      {items.map((item) => (
        <li key={`${item.href}|${item.label}`}>
          {isExternalHref(item.href) ? (
            <a href={item.href} rel="noopener noreferrer">
              {item.label}
              <span className="visually-hidden"> {t('common.externalLink')}</span>
            </a>
          ) : (
            <Link href={item.href} aria-current={item.href === current ? 'page' : undefined}>
              {item.label}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
