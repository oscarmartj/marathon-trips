import type { ReactNode } from 'react';

/** The single h1 of a page, with an intro line. */
export function PageHeader({ title, intro, children }: { title: string; intro?: string; children?: ReactNode }) {
  return (
    <div className="page-header container">
      <h1>{title}</h1>
      {intro ? <p>{intro}</p> : null}
      {children}
    </div>
  );
}
