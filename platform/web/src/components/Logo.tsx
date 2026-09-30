import { JAR_BAND, JAR_BODY, JAR_COLORS, JAR_GLAZE, JAR_LIP } from '../brand/jar';

/** The clay-jar mark. Decorative wherever the name "Skeuos" is also on screen. */
export function JarMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={JAR_BODY} fill={JAR_COLORS.body} />
      <path d={JAR_LIP} fill={JAR_COLORS.lip} />
      <path d={JAR_BAND} fill={JAR_COLORS.lip} />
      <path d={JAR_GLAZE} fill={JAR_COLORS.glaze} />
    </svg>
  );
}

/** The header lockup: jar + "Skeuos" in the display serif. */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      <JarMark size={Math.round(size * 1.05)} />
      <span>Skeuos</span>
    </span>
  );
}
