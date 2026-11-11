import { brand } from '@mt/shared/brand';

/**
 * Placeholder artwork (no photos are downloaded). Replace with real images later: pass `src`
 * to render an <img> instead. `alt` is required and comes from the translation layer.
 */
export function PlaceholderImage({ alt, src }: { alt: string; src?: string }) {
  if (src) {
    return <img className="placeholder-image" src={src} alt={alt} />;
  }
  const c = brand.colours;
  return (
    <svg className="placeholder-image" viewBox="0 0 400 300" role="img" aria-label={alt}>
      <rect width="400" height="300" fill={c.night} />
      <path d="M0 230 L400 150 V300 H0Z" fill={c.primary} />
      <path d="M0 260 L400 190 V300 H0Z" fill={c.accent} />
      <circle cx="300" cy="80" r="38" fill={c.accent} />
    </svg>
  );
}
