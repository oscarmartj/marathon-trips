import { serialiseJsonLd, type JsonLd } from '@/lib/seo';

/** Structured data for search engines. Renders nothing visible. */
export function JsonLdScript({ data }: { data: JsonLd | JsonLd[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serialiseJsonLd(data) }} />;
}
