import type { ReactNode } from 'react';
import { Logo } from './logo';

/** Frame for the staff sign-in and set-up pages: no admin navigation before a session exists. */
export function AuthFrame({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <main id="main" className="auth-frame">
      <div className="card stack auth-frame__card">
        <Logo />
        <h1>{title}</h1>
        <p>{intro}</p>
        {children}
      </div>
    </main>
  );
}
