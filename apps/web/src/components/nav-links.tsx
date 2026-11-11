import Link from 'next/link';
import type { RouteDef } from '@/lib/routes';
import { t } from '@/lib/i18n';

/** A list of links. Server component: the active page is passed in, so no client JavaScript is needed. */
export function NavLinks({ routes, current }: { routes: readonly RouteDef[]; current?: string }) {
  return (
    <ul className="nav-list">
      {routes.map((r) => (
        <li key={r.path}>
          <Link href={r.path} aria-current={r.path === current ? 'page' : undefined}>
            {t(r.labelKey)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
