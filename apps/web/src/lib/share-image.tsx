import { ImageResponse } from 'next/og';
import { brand } from '@mt/shared/brand';

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const SHARE_IMAGE_TYPE = 'image/png';

/**
 * The picture shown when a page is shared. Drawn from the brand configuration only (colours, name, logo mark):
 * no photographs, no downloaded fonts. `heading` and `line` are already-translated text.
 */
export function shareImage(heading: string, line: string): ImageResponse {
  const { colours, logo, fonts } = brand;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: colours.night, color: colours.onNight, fontFamily: fonts.body }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <svg width="72" height="72" viewBox={logo.markViewBox}>
            <path d={logo.markPath} fill={colours.accent} />
          </svg>
          <div style={{ fontSize: 40, fontWeight: 700 }}>{brand.name}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ fontSize: heading.length > 40 ? 64 : 84, fontWeight: 800, lineHeight: 1.05 }}>{heading}</div>
          <div style={{ fontSize: 36, color: colours.accent }}>{line}</div>
        </div>
        <div style={{ display: 'flex', height: 16, width: '100%', background: colours.primary }} />
      </div>
    ),
    SHARE_IMAGE_SIZE,
  );
}
