/**
 * The Skeuos mark, "the pack" (platform/docs/design/Brand.dc.html, card A): a
 * pack with a carry handle, a flap and an S-shaped strap, on a 48-unit box.
 * One definition feeds the header lockup (components/Logo.tsx) and the icon
 * generator (scripts/generate-icons.ts), so the favicon, the PWA icons and the
 * lockup can never drift apart.
 *
 * The strokes use round caps (and the strap round joins), exactly as the
 * artboard draws them. Path data is copied verbatim from the artboard; the
 * generator's own parser flattens it for the PNGs.
 */

export const PACK_BOX = 48;

export interface PackStroke {
  readonly d: string;
  readonly width: number;
}

/** The carry handle above the body. */
export const PACK_HANDLE: PackStroke = { d: 'M18 12V9.5a6 6 0 0 1 12 0V12', width: 3.2 };

/** The body: a rounded rectangle. */
export const PACK_BODY = { x: 7, y: 12, width: 34, height: 31, rx: 10 } as const;

/** The flap's lower edge, drawn in the ground colour across the body. */
export const PACK_FLAP: PackStroke = { d: 'M7.5 20.5c6 4.2 27 4.2 33 0', width: 2.4 };

/** The S-shaped strap on the front, also in the ground colour. */
export const PACK_STRAP: PackStroke = {
  d: 'M28 29.2C26.5 27.6 20.2 27.8 20.2 31C20.2 34.4 27.8 33.3 27.8 36.8C27.8 40 21.6 40.2 20 38.6',
  width: 2.4,
};

/** Brand colours the mark and the icons use (the same values as tokens.css). */
export const PACK_COLORS = {
  pine: '#24402E',
  canvas: '#F3EEE3',
  card: '#FFFDF8',
} as const;

/**
 * The app icon (Brand.dc.html, card A, second SVG): a pine tile of 64 units
 * with corner radius 15, and the 48-unit pack inset 8 units, in canvas with
 * pine details.
 */
export const APP_ICON = { box: 64, radius: 15, inset: 8 } as const;
