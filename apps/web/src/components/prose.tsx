import { paragraphs } from '@/lib/content';

/** Plain text from the content manager as paragraphs. Never HTML: markup in the text is shown as the characters it is. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((p, i) => (
        <p key={i} className="prose">{p}</p>
      ))}
    </>
  );
}
