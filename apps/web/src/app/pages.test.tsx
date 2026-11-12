import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes, publicRoutes } from '@/lib/routes';
import { SLUG, stubCatalogue } from '@/test/catalogue-fixtures';

type PageModule = { default: (props: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string>> }) => unknown };

// Catalogue pages read the public API; the tests give them a fixed answer.
beforeEach(() => {
  stubCatalogue();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function render(file: string) {
  const mod = (await import(/* @vite-ignore */ `./${file.replace(/\.tsx$/, '')}`)) as PageModule;
  const element = await mod.default({ params: Promise.resolve({ slug: SLUG }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as never);
}

describe.each([...publicRoutes, ...adminRoutes])('page $path', (route) => {
  it('renders exactly one h1 and no empty links or images without alt text', async () => {
    const html = await render(route.file);
    expect(html.match(/<h1[ >]/g)?.length).toBe(1);
    expect(html).not.toMatch(/<a [^>]*>\s*<\/a>/);
    expect(html).not.toMatch(/<img(?![^>]*\balt=)/);
  });
});

describe('page content', () => {
  it('marks every legal page as pending legal review, visibly', async () => {
    for (const r of publicRoutes.filter((x) => x.footer === 'legal')) {
      expect(await render(r.file)).toContain('pending legal review');
    }
  });

  it('marks the current admin page with aria-current', async () => {
    expect(await render('admin/(panel)/bookings/page.tsx')).toMatch(/aria-current="page" href="\/admin\/bookings"/);
  });

  it('makes no accreditation or guaranteed-entry claims', async () => {
    for (const r of publicRoutes) {
      expect(await render(r.file)).not.toMatch(/official (partner|operator)|guaranteed entry|accredited/i);
    }
  });
});
