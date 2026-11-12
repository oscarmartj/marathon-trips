import type { MediaRef } from '@/lib/content';

/**
 * An image from the content manager's library. A described image gets its description as alt text; one marked decorative
 * gets an empty alt so screen readers skip it. Width and height reserve the space so the page does not jump.
 */
export function ContentImage({ media }: { media: MediaRef }) {
  return (
    <img
      className="content-image"
      src={media.src}
      alt={media.decorative ? '' : media.altText}
      {...(media.width && media.height ? { width: media.width, height: media.height } : {})}
      loading="lazy"
      decoding="async"
    />
  );
}
