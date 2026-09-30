/**
 * The Skeuos mark: a clay jar (skeuos, a vessel), terracotta on the app's
 * ground colour. One definition feeds the React logo and the icon generator
 * (scripts/generate-icons.ts), so the favicon, the PWA icons and the header
 * lockup can never drift apart.
 *
 * Paths use a 24 x 24 box and only absolute M, L, C and Z commands, which is
 * what the generator's rasterizer understands.
 */

export const JAR_BOX = 24;

/** The pot: a rolled lip, a flared neck, a shouldered belly and a small foot. */
export const JAR_BODY =
  'M8.55 2 L15.45 2 C15.9 2 16.25 2.35 16.25 2.8 L16.25 3.2 C16.25 3.65 15.9 4 15.45 4 ' +
  'L14.1 4 L14.35 6.35 C17.35 7.05 19.6 9.1 19.6 11.9 C19.6 15.3 17.9 18.8 15.4 20.4 ' +
  'L15.85 21.45 C15.95 21.75 15.75 22 15.45 22 L8.55 22 C8.25 22 8.05 21.75 8.15 21.45 L8.6 20.4 ' +
  'C6.1 18.8 4.4 15.3 4.4 11.9 C4.4 9.1 6.65 7.05 9.65 6.35 L9.9 4 L8.55 4 ' +
  'C8.1 4 7.75 3.65 7.75 3.2 L7.75 2.8 C7.75 2.35 8.1 2 8.55 2 Z';

/** The rim, fired darker. */
export const JAR_LIP =
  'M8.55 2 L15.45 2 C15.9 2 16.25 2.35 16.25 2.8 L16.25 3.2 C16.25 3.65 15.9 4 15.45 4 ' +
  'L8.55 4 C8.1 4 7.75 3.65 7.75 3.2 L7.75 2.8 C7.75 2.35 8.1 2 8.55 2 Z';

/** A painted band around the shoulder; its ends sit on the silhouette, its middle follows the curve. */
export const JAR_BAND = 'M5.7 8.55 C9.45 9.35 14.55 9.35 18.3 8.55 L18.89 9.35 C14.75 10.2 9.25 10.2 5.11 9.35 Z';

/** A glaze highlight on the belly. */
export const JAR_GLAZE = 'M6.1 14.2 C6.1 12.4 6.8 11.1 7.9 10.3 C7.2 11.4 6.9 12.6 6.95 14.3 Z';

export const JAR_COLORS = {
  body: '#C2410C',
  lip: '#9A3412',
  glaze: '#F2C4A0',
  ground: '#F6F3EC',
} as const;
