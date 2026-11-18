import type { Page } from '@playwright/test';

/**
 * Task 8.3: a small WCAG 2.2 AA audit that runs inside the page, so the check needs no extra dependency. It covers what a
 * machine can judge: language, title, landmarks, heading order, names for images, links, buttons and fields, id references,
 * target size (2.5.8), text contrast (1.4.3) and reflow without sideways scrolling (1.4.10). Keyboard order, focus
 * visibility (2.4.7, 2.4.11) and the skip link are driven by `auditKeyboard`. A screen reader still needs a person.
 */
export interface Finding {
  rule: string;
  detail: string;
}

/** Runs in the browser; kept self-contained (no imports) because Playwright serialises it. */
function auditInPage(): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, detail: string) => out.push({ rule, detail });
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}> "${text}"`;
  };
  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Hidden by the visually-hidden pattern: still read by assistive technology, so it is not judged on size or contrast.
  const clipped = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1;
  };

  const root = document.documentElement;
  if (root.lang !== 'en-AU') add('3.1.1 language', `html lang is "${root.lang}", expected en-AU`);
  if (!document.title.trim()) add('2.4.2 page title', 'the page has no title');

  const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
  if (/user-scalable\s*=\s*(no|0)/i.test(viewport) || /maximum-scale\s*=\s*(0?\.\d+|1(\.0+)?)\b/i.test(viewport)) add('1.4.4 resize text', `the viewport blocks zoom: ${viewport}`);

  // Landmarks.
  if (document.querySelectorAll('main, [role="main"]').length !== 1) add('1.3.1 landmarks', 'expected exactly one main landmark');
  if (document.querySelectorAll('body > header, body > * > header, [role="banner"]').length < 1) add('1.3.1 landmarks', 'no banner (header) landmark');
  if (document.querySelectorAll('footer, [role="contentinfo"]').length < 1) add('1.3.1 landmarks', 'no contentinfo (footer) landmark');
  const navs = Array.from(document.querySelectorAll('nav'));
  const navNames = navs.map((n) => n.getAttribute('aria-label') ?? n.getAttribute('aria-labelledby') ?? '');
  if (navs.length > 1 && navNames.some((n) => !n)) add('1.3.1 landmarks', 'with more than one nav, every nav needs its own label');
  if (new Set(navNames.filter(Boolean)).size !== navNames.filter(Boolean).length) add('1.3.1 landmarks', 'two navs share a label');

  // Headings: one h1 in the page, and no level skipped on the way down.
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).filter(visible);
  const levels = headings.map((h) => (h.hasAttribute('aria-level') ? Number(h.getAttribute('aria-level')) : Number(h.tagName.slice(1))));
  if (levels.filter((l) => l === 1).length !== 1) add('1.3.1 headings', `expected one h1, found ${levels.filter((l) => l === 1).length}`);
  levels.forEach((l, i) => {
    if (i > 0 && l > levels[i - 1]! + 1) add('1.3.1 headings', `h${levels[i - 1]} is followed by h${l} (${describe(headings[i]!)})`);
  });
  headings.forEach((h) => {
    if (!(h.textContent ?? '').trim() && !h.querySelector('img[alt]:not([alt=""])')) add('2.4.6 headings', 'an empty heading');
  });

  // Images and SVG.
  document.querySelectorAll('img').forEach((img) => {
    if (!img.hasAttribute('alt')) add('1.1.1 images', `img without alt: ${img.getAttribute('src')}`);
  });
  document.querySelectorAll('svg').forEach((svg) => {
    if (svg.closest('[aria-hidden="true"]') || svg.getAttribute('aria-hidden') === 'true') return;
    const named = svg.getAttribute('aria-label') || svg.getAttribute('aria-labelledby') || svg.querySelector('title');
    if (!named && svg.getAttribute('role') !== 'presentation' && visible(svg)) add('1.1.1 images', 'an svg that is neither named nor hidden from assistive technology');
  });

  // Accessible names.
  const nameOf = (el: Element): string => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) return labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = Array.from(el.labels ?? []).map((l) => l.textContent ?? '').join(' ').trim();
      if (labels) return labels;
      if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return el.value;
      return el.getAttribute('title') ?? '';
    }
    const imgAlt = Array.from(el.querySelectorAll('img[alt]')).map((i) => i.getAttribute('alt') ?? '').join(' ');
    const svgName = Array.from(el.querySelectorAll('svg[aria-label], svg title')).map((s) => s.getAttribute('aria-label') ?? s.textContent ?? '').join(' ');
    return `${(el.textContent ?? '').replace(/\s+/g, ' ').trim()} ${imgAlt} ${svgName}`.trim() || (el.getAttribute('title') ?? '');
  };
  document.querySelectorAll('a[href], button, [role="button"], [role="link"]').forEach((el) => {
    if (!nameOf(el)) add('4.1.2 names', `a link or button with no name: ${el.outerHTML.slice(0, 80)}`);
  });
  document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((el) => {
    if (!nameOf(el)) add('3.3.2 labels', `a field with no label: ${el.outerHTML.slice(0, 80)}`);
    const auto = (el as HTMLInputElement).autocomplete;
    const type = (el as HTMLInputElement).type;
    if (type === 'email' && el.getAttribute('name') && !auto && /email/i.test(nameOf(el)) && !/search|alert/i.test(nameOf(el))) add('1.3.5 input purpose', `an email field without autocomplete: ${nameOf(el)}`);
  });
  document.querySelectorAll('fieldset').forEach((f) => {
    if (!f.querySelector(':scope > legend')) add('1.3.1 groups', 'a fieldset without a legend');
  });
  document.querySelectorAll('table').forEach((t) => {
    if (!t.querySelector('th')) add('1.3.1 tables', 'a table without header cells');
  });

  // Ids are unique and every reference resolves.
  const seen = new Map<string, number>();
  document.querySelectorAll('[id]').forEach((el) => seen.set(el.id, (seen.get(el.id) ?? 0) + 1));
  seen.forEach((n, id) => {
    if (n > 1) add('4.1.1 duplicate id', `id "${id}" is used ${n} times`);
  });
  document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]').forEach((el) => {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean).forEach((id) => {
        if (!document.getElementById(id)) add('4.1.2 references', `${attr}="${id}" points at nothing`);
      });
    }
  });
  document.querySelectorAll('[tabindex]').forEach((el) => {
    if (Number(el.getAttribute('tabindex')) > 0) add('2.4.3 focus order', `positive tabindex on ${describe(el)}`);
  });
  document.querySelectorAll('a[target="_blank"]').forEach((a) => {
    if (!/noopener/.test(a.getAttribute('rel') ?? '')) add('security hygiene', `target=_blank without rel=noopener: ${a.getAttribute('href')}`);
  });

  // Target size (2.5.8): at least 24 by 24 CSS pixels, except links inside a sentence.
  document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary').forEach((el) => {
    if (!visible(el) || clipped(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width >= 23.5 && r.height >= 23.5) return;
    if (el.tagName === 'A') {
      const block = el.closest('p, li, dd, td, label');
      const own = (block?.textContent ?? '').replace(el.textContent ?? '', '').trim();
      if (block && own.length > 10) return;
    }
    add('2.5.8 target size', `${describe(el)} is ${Math.round(r.width)}x${Math.round(r.height)}px`);
  });

  // Text contrast (1.4.3): every element with its own text, against the colour actually painted behind it.
  type Rgba = [number, number, number, number];
  const parse = (c: string): Rgba | null => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  };
  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / a).concat(a) as Rgba;
  };
  const lum = (c: Rgba): number => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const backdrop = (el: Element): Rgba | null => {
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
    let bg: Rgba = [255, 255, 255, 1];
    for (const e of chain.reverse()) {
      const s = getComputedStyle(e);
      if (s.backgroundImage !== 'none') return null; // gradients and pictures cannot be judged here
      const c = parse(s.backgroundColor);
      if (c) bg = over(c, bg);
    }
    return bg;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const checked = new Set<Element>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || checked.has(el) || !(n.textContent ?? '').trim() || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) continue;
    checked.add(el);
    if (!visible(el) || clipped(el) || el.closest('[aria-hidden="true"], [disabled], [aria-disabled="true"]')) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const bg = backdrop(el);
    if (!fg || !bg) continue;
    let opacity = 1;
    for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    const text = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    const [l1, l2] = [lum(text), lum(bg)].sort((a, b) => b - a) as [number, number];
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    if (ratio < (large ? 3 : 4.5) - 0.01) add('1.4.3 contrast', `${describe(el)} has ${ratio.toFixed(2)}:1 (needs ${large ? 3 : 4.5}:1)`);
  }
  return out;
}

export async function auditPage(page: Page): Promise<Finding[]> {
  return page.evaluate(auditInPage);
}

/** Reflow (1.4.10) at 320px wide, and with the text spacing of 1.4.12 applied: nothing may need a sideways scroll. */
export async function auditReflow(page: Page): Promise<Finding[]> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 640 });
  const findings: Finding[] = [];
  const overflow = () =>
    page.evaluate(() => {
      const wide = Array.from(document.body.querySelectorAll('*'))
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > document.documentElement.clientWidth + 1 && !e.closest('.table-wrap, pre, [tabindex]');
        })
        .slice(0, 3)
        .map((e) => `<${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''} class="${e.getAttribute('class') ?? ''}">`);
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, wide };
    });
  let o = await overflow();
  if (o.scrollWidth > o.clientWidth + 1) findings.push({ rule: '1.4.10 reflow', detail: `scrolls sideways at 320px (${o.scrollWidth}px); wide: ${o.wide.join(', ')}` });
  const style = await page.addStyleTag({
    content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
  });
  o = await overflow();
  if (o.scrollWidth > o.clientWidth + 1) findings.push({ rule: '1.4.12 text spacing', detail: `scrolls sideways with wider text spacing (${o.scrollWidth}px); wide: ${o.wide.join(', ')}` });
  await style.evaluate((el) => el.remove());
  if (original) await page.setViewportSize(original);
  return findings;
}

/**
 * Keyboard: the first Tab lands on the skip link, which is visible and moves focus into the page; then every stop shows a
 * focus indicator and is not covered by other content (2.4.7, 2.4.11), and focus never leaves the document in a trap.
 */
export async function auditKeyboard(page: Page): Promise<Finding[]> {
  const findings: Finding[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    return { href: el?.getAttribute('href') ?? null, onScreen: !!r && r.top >= 0 && r.bottom > 0 && r.width > 1 };
  });
  if (first.href !== '#main') findings.push({ rule: '2.4.1 bypass blocks', detail: `the first Tab stop is ${first.href ?? 'not a link'}, expected the skip link (#main)` });
  if (!first.onScreen) findings.push({ rule: '2.4.1 bypass blocks', detail: 'the skip link is not visible when it has focus' });
  if (first.href !== '#main') return findings; // pressing Enter on some other link would leave the page
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  // Focus continues from the target of the skip link: in main when main has something to focus, otherwise after it (the footer).
  const afterSkip = await page.evaluate(() => {
    const main = document.querySelector('main');
    const el = document.activeElement;
    return !!main && !!el && el !== main && (main.contains(el) || !!(main.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  if (!afterSkip) findings.push({ rule: '2.4.1 bypass blocks', detail: 'after the skip link, the next Tab stop is still before main (the header was not skipped)' });

  const stops = await page.evaluate(() => document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex="0"]').length);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const limit = Math.min(stops + 5, 120);
  const seen = new Set<string>();
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hasOutline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
      const hasShadow = s.boxShadow !== 'none';
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      const covered = rect.width > 0 && !!top && top !== el && !el.contains(top) && !top.contains(el);
      const label = `<${el.tagName.toLowerCase()}> "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)}"`;
      return { label, key: `${el.tagName}${el.id}${rect.top}${rect.left}`, hasIndicator: hasOutline || hasShadow, covered };
    });
    if (!r) break;
    if (seen.has(r.key)) break;
    seen.add(r.key);
    if (!r.hasIndicator) findings.push({ rule: '2.4.7 focus visible', detail: `${r.label} shows no focus indicator` });
    if (r.covered) findings.push({ rule: '2.4.11 focus not obscured', detail: `${r.label} is covered by other content when focused` });
  }
  return findings;
}
