import type { TagView } from './shared';

/** The tag's name is always shown; the colour is only a marker beside it, never the only signal. */
export function TagChip({ tag }: { tag: TagView }) {
  return (
    <span className="chip">
      <span className="chip__dot" style={{ background: tag.colour }} aria-hidden="true" />
      {tag.name}
    </span>
  );
}
