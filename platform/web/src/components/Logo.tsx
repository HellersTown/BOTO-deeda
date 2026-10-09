import { PACK_BODY, PACK_BOX, PACK_FLAP, PACK_HANDLE, PACK_STRAP } from '../brand/pack';

/**
 * The pack mark. Pine by default; the flap and strap are drawn in the colour of
 * whatever the mark sits on (the `--pack-detail` custom property, the ground by
 * default), so they read as cut-outs. Decorative wherever the name is also on
 * screen.
 */
export function PackMark({ size = 28, title }: { size?: number; title?: string }) {
  const b = PACK_BODY;
  return (
    <svg
      className="pack-mark"
      width={size}
      height={size}
      viewBox={`0 0 ${PACK_BOX} ${PACK_BOX}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path className="pack-mark__ink-line" d={PACK_HANDLE.d} fill="none" strokeWidth={PACK_HANDLE.width} strokeLinecap="round" />
      <rect className="pack-mark__ink" x={b.x} y={b.y} width={b.width} height={b.height} rx={b.rx} />
      <path className="pack-mark__detail" d={PACK_FLAP.d} fill="none" strokeWidth={PACK_FLAP.width} strokeLinecap="round" />
      <path
        className="pack-mark__detail"
        d={PACK_STRAP.d}
        fill="none"
        strokeWidth={PACK_STRAP.width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The header lockup: the pine pack and "Skeuos" in Zilla Slab 700, pine. */
export function Wordmark({ size = 24, markSize }: { size?: number; markSize?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      <PackMark size={markSize ?? Math.round(size * 1.08)} />
      <span>Skeuos</span>
    </span>
  );
}
