/**
 * The single brand configuration file: name, colours, typography and logo.
 * Change the brand here and nowhere else. The web app turns this into CSS custom properties
 * (see `brandCssVariables`) and reads the name and logo from it. Colour pairs listed in
 * `contrastPairs` are checked against WCAG 2.2 AA by `brand.test.ts`.
 */
export interface BrandColours {
  /** Page background and cards. */
  surface: string;
  /** Subtle section background. */
  surfaceMuted: string;
  /** Body text. */
  ink: string;
  /** Secondary text. */
  inkMuted: string;
  /** Hairlines and input borders (non-text, 3:1 on surface). */
  border: string;
  /** Main brand colour: buttons, links, key shapes. */
  primary: string;
  /** Text on `primary`. */
  onPrimary: string;
  /** Hover state of `primary`. */
  primaryStrong: string;
  /** High-energy highlight. */
  accent: string;
  /** Text on `accent`. */
  onAccent: string;
  /** Dark hero and admin sidebar background. */
  night: string;
  /** Text on `night`. */
  onNight: string;
  /** Visible keyboard focus ring. */
  focus: string;
  /** Error and warning text on `surface`. */
  danger: string;
  /** Notice banners such as "pending legal review". */
  notice: string;
  onNotice: string;
}

export interface BrandConfig {
  name: string;
  /** Used where space is tight, such as the admin sidebar. */
  shortName: string;
  colours: BrandColours;
  fonts: { display: string; body: string };
  logo: {
    /** SVG path data for the mark, drawn in a 0 0 32 32 box and filled with the primary colour. */
    markPath: string;
    markViewBox: string;
  };
  /** Pairs of [foreground, background] colour keys that must meet WCAG 2.2 AA for text (4.5:1). */
  contrastPairs: ReadonlyArray<readonly [keyof BrandColours, keyof BrandColours]>;
  /** Pairs that only need the 3:1 non-text ratio (borders, focus ring, icons). */
  nonTextPairs: ReadonlyArray<readonly [keyof BrandColours, keyof BrandColours]>;
}

export const brand: BrandConfig = {
  name: 'Marathon Trips',
  shortName: 'MT',
  colours: {
    surface: '#ffffff',
    surfaceMuted: '#f2f4f8',
    ink: '#0b1220',
    inkMuted: '#4a5568',
    border: '#7b8494',
    primary: '#c92a00',
    onPrimary: '#ffffff',
    primaryStrong: '#9c2000',
    accent: '#c8f031',
    onAccent: '#0b1220',
    night: '#0b1220',
    onNight: '#ffffff',
    focus: '#1a4fd6',
    danger: '#b00020',
    notice: '#fff1b8',
    onNotice: '#3d2f00',
  },
  // System fonts only: no font files are downloaded, so the site stays light and works offline.
  fonts: {
    display: '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif',
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  logo: {
    // A forward-leaning chevron pair: motion and a finish line.
    markPath: 'M4 6h8l8 10-8 10H4l8-10L4 6Zm12 0h8l8 10-8 10h-8l8-10-8-10Z',
    markViewBox: '0 0 32 32',
  },
  contrastPairs: [
    ['ink', 'surface'],
    ['ink', 'surfaceMuted'],
    ['inkMuted', 'surface'],
    ['inkMuted', 'surfaceMuted'],
    ['onPrimary', 'primary'],
    ['onPrimary', 'primaryStrong'],
    ['primary', 'surface'],
    ['onAccent', 'accent'],
    ['onNight', 'night'],
    ['accent', 'night'],
    ['danger', 'surface'],
    ['onNotice', 'notice'],
  ],
  nonTextPairs: [
    ['border', 'surface'],
    ['focus', 'surface'],
    ['primary', 'night'],
  ],
};

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** CSS custom properties for the brand, as a `:root { ... }` rule. */
export function brandCssVariables(b: BrandConfig = brand): string {
  const lines = [
    ...Object.entries(b.colours).map(([k, v]) => `--color-${kebab(k)}:${v};`),
    `--font-display:${b.fonts.display};`,
    `--font-body:${b.fonts.body};`,
  ];
  return `:root{${lines.join('')}}`;
}
