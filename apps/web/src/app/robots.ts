import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/site';

// Read per request, so the sitemap address follows WEB_ORIGIN at run time.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    // The admin panel, the API proxy and the pages that act on one customer's own data are not for search engines.
    rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/api/', '/account', '/checkout', '/alerts/'] },
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
