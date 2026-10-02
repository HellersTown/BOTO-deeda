/**
 * Writes the favicon and PWA icons, as SVG and as PNG, from src/brand/pack.ts.
 *
 *   npm run icons      (node --experimental-strip-types scripts/generate-icons.ts)
 *
 * Every icon is the app icon from Brand.dc.html (card A, second SVG): a pine
 * tile with the pack in canvas and pine details. The maskable variants are full
 * bleed with the pack a little smaller, inside the safe zone.
 *
 * No dependencies. The pack's paths are parsed (M, L, H, V, C, A and their
 * relative forms, Z) and flattened to polylines. Fills use 4 x 4 supersampled
 * even-odd scanlines; strokes are drawn as the set of points within half the
 * stroke width of the polyline, which is exactly a round cap and a round join.
 * PNGs are encoded with node:zlib. They exist because iOS home-screen icons and
 * some install prompts do not accept SVG.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  APP_ICON,
  PACK_BODY,
  PACK_COLORS,
  PACK_FLAP,
  PACK_HANDLE,
  PACK_STRAP,
  type PackStroke,
} from '../src/brand/pack.ts';

type Point = readonly [number, number];
type Rgb = readonly [number, number, number];

// ------------------------------------------------------------------- geometry

/** An SVG path to polylines (one per subpath), curves and arcs flattened. */
function flatten(d: string, steps = 32): { points: Point[]; closed: boolean }[] {
  const tokens = d.match(/[MmLlHhVvCcAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out: { points: Point[]; closed: boolean }[] = [];
  let current: Point[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;
  let cmd = '';
  const num = (): number => Number(tokens[i++]);
  const isNumber = (t: string | undefined): boolean => t !== undefined && !/^[A-Za-z]$/.test(t);
  const finish = (closed: boolean): void => {
    if (current.length > 0) out.push({ points: current, closed });
    current = [];
  };

  while (i < tokens.length) {
    if (!isNumber(tokens[i])) cmd = tokens[i++] as string;
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        finish(false);
        x = (rel ? x : 0) + num();
        y = (rel ? y : 0) + num();
        startX = x;
        startY = y;
        current = [[x, y]];
        cmd = rel ? 'l' : 'L'; // further pairs are implicit line-tos
        break;
      }
      case 'L':
        x = (rel ? x : 0) + num();
        y = (rel ? y : 0) + num();
        current.push([x, y]);
        break;
      case 'H':
        x = (rel ? x : 0) + num();
        current.push([x, y]);
        break;
      case 'V':
        y = (rel ? y : 0) + num();
        current.push([x, y]);
        break;
      case 'C': {
        const ox = rel ? x : 0;
        const oy = rel ? y : 0;
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        const x0 = x;
        const y0 = y;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const u = 1 - t;
          current.push([
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          ]);
        }
        x = x3;
        y = y3;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rotation = num(), large = num(), sweep = num();
        const ex = (rel ? x : 0) + num();
        const ey = (rel ? y : 0) + num();
        current.push(...arcPoints(x, y, rx, ry, rotation, large !== 0, sweep !== 0, ex, ey, steps));
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        x = startX;
        y = startY;
        finish(true);
        break;
      default:
        throw new Error(`Unsupported path command ${cmd}`);
    }
  }
  finish(false);
  return out;
}

/** SVG elliptical arc (endpoint form) to points, per SVG 1.1 appendix F.6.5. */
function arcPoints(
  x1: number, y1: number, rxIn: number, ryIn: number, rotationDeg: number,
  large: boolean, sweep: boolean, x2: number, y2: number, steps: number,
): Point[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [[x2, y2]];
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const out: Point[] = [];
  for (let s = 1; s <= steps; s++) {
    const t = theta1 + (delta * s) / steps;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  return out;
}

/** A rounded rectangle as a closed path, corners drawn with cubic quarter-circles. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = 0.5523 * r;
  return [
    `M${x + r} ${y}`, `L${x + w - r} ${y}`, `C${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r}`,
    `L${x + w} ${y + h - r}`, `C${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h}`,
    `L${x + r} ${y + h}`, `C${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r}`,
    `L${x} ${y + r}`, `C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}`, 'Z',
  ].join(' ');
}

function transform(points: readonly Point[], scale: number, dx: number, dy: number): Point[] {
  return points.map(([px, py]) => [px * scale + dx, py * scale + dy] as Point);
}

// ------------------------------------------------------------------ raster

class Canvas {
  readonly size: number;
  /** Samples per pixel along each axis: more for the small icons, where every edge shows. */
  readonly ss: number;
  readonly data: Float64Array;
  constructor(size: number) {
    this.size = size;
    this.ss = size <= 64 ? 8 : 4;
    this.data = new Float64Array(size * size * 4);
  }

  /** Composites a coverage mask (0..1 per pixel) in one colour, "over". */
  private paint(coverage: Float64Array, [r, g, b]: Rgb): void {
    const n = this.size;
    for (let p = 0; p < n * n; p++) {
      const a = Math.min(1, coverage[p] as number);
      if (a === 0) continue;
      const o = p * 4;
      const da = this.data[o + 3] as number;
      const outA = a + da * (1 - a);
      const mix = (c: number, dc: number): number => (c * a + dc * da * (1 - a)) / outA;
      this.data[o] = mix(r, this.data[o] as number);
      this.data[o + 1] = mix(g, this.data[o + 1] as number);
      this.data[o + 2] = mix(b, this.data[o + 2] as number);
      this.data[o + 3] = outA;
    }
  }

  /** Even-odd fill of closed polygons. */
  fill(polys: readonly (readonly Point[])[], color: Rgb): void {
    const n = this.size;
    const ss = this.ss;
    const coverage = new Float64Array(n * n);
    const edges = polys.flatMap((p) => p.map((a, j) => [a, p[(j + 1) % p.length] as Point] as const));
    for (let sy = 0; sy < n * ss; sy++) {
      const y = (sy + 0.5) / ss;
      const xs: number[] = [];
      for (const [[x0, y0], [x1, y1]] of edges) {
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      const row = Math.floor(sy / ss) * n;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k] as number) * ss - 0.5));
        const to = Math.min(n * ss - 1, Math.floor((xs[k + 1] as number) * ss - 0.5));
        for (let sx = from; sx <= to; sx++) coverage[row + Math.floor(sx / ss)] += 1 / (ss * ss);
      }
    }
    this.paint(coverage, color);
  }

  /** A stroke of the given width: every sample within width / 2 of the polyline (round caps and joins). */
  stroke(line: readonly Point[], width: number, color: Rgb): void {
    const n = this.size;
    const ss = this.ss;
    const half = width / 2;
    const coverage = new Float64Array(n * n);
    const xs = line.map((p) => p[0]);
    const ys = line.map((p) => p[1]);
    const minX = Math.max(0, Math.floor((Math.min(...xs) - half) * ss));
    const maxX = Math.min(n * ss - 1, Math.ceil((Math.max(...xs) + half) * ss));
    const minY = Math.max(0, Math.floor((Math.min(...ys) - half) * ss));
    const maxY = Math.min(n * ss - 1, Math.ceil((Math.max(...ys) + half) * ss));
    const segments = line.length === 1 ? [[line[0], line[0]] as const] : line.slice(1).map((b, j) => [line[j] as Point, b] as const);
    const h2 = half * half;
    for (let sy = minY; sy <= maxY; sy++) {
      const py = (sy + 0.5) / ss;
      for (let sx = minX; sx <= maxX; sx++) {
        const px = (sx + 0.5) / ss;
        let inside = false;
        for (const [[ax, ay], [bx, by]] of segments) {
          const vx = bx - ax;
          const vy = by - ay;
          const len2 = vx * vx + vy * vy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
          const qx = ax + t * vx - px;
          const qy = ay + t * vy - py;
          if (qx * qx + qy * qy <= h2) {
            inside = true;
            break;
          }
        }
        if (inside) coverage[Math.floor(sy / ss) * n + Math.floor(sx / ss)] += 1 / (ss * ss);
      }
    }
    this.paint(coverage, color);
  }

  png(): Buffer {
    const n = this.size;
    const raw = Buffer.alloc(n * (n * 4 + 1));
    for (let y = 0; y < n; y++) {
      raw[y * (n * 4 + 1)] = 0; // filter: none
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        const t = y * (n * 4 + 1) + 1 + x * 4;
        raw[t] = Math.round(this.data[o] as number);
        raw[t + 1] = Math.round(this.data[o + 1] as number);
        raw[t + 2] = Math.round(this.data[o + 2] as number);
        raw[t + 3] = Math.round((this.data[o + 3] as number) * 255);
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(n, 0);
    ihdr.writeUInt32BE(n, 4);
    ihdr.writeUInt8(8, 8); // bit depth
    ihdr.writeUInt8(6, 9); // RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function hex(color: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) throw new Error(`bad colour ${color}`);
  return [parseInt(m[1] as string, 16), parseInt(m[2] as string, 16), parseInt(m[3] as string, 16)];
}

// ------------------------------------------------------------------ icons

interface IconSpec {
  /** 'rounded': the design's tile; 'full': full bleed (maskable, iOS, which masks it itself). */
  readonly tile: 'rounded' | 'full';
  /**
   * 'design': the pack exactly where the artboard puts it (inset 8 of 64).
   * 'safe': a little smaller and centred on the drawn shape, inside the
   * maskable safe zone (a circle of 40% of the icon's width).
   */
  readonly placement: 'design' | 'safe';
}

/** The drawn extent of the pack in its 48-unit box: the handle's top (stroke included) to the body's foot. */
const PACK_EXTENT = { top: 9.5 - 6 - PACK_HANDLE.width / 2, bottom: PACK_BODY.y + PACK_BODY.height, left: PACK_BODY.x, right: PACK_BODY.x + PACK_BODY.width };

/** Scale and offset that map the 48-unit pack box into an icon `size` wide. */
function placePack(size: number, placement: IconSpec['placement']): { scale: number; dx: number; dy: number } {
  const unit = size / APP_ICON.box;
  if (placement === 'design') return { scale: unit, dx: APP_ICON.inset * unit, dy: APP_ICON.inset * unit };
  const scale = unit * 0.9;
  const cx = (PACK_EXTENT.left + PACK_EXTENT.right) / 2;
  const cy = (PACK_EXTENT.top + PACK_EXTENT.bottom) / 2;
  return { scale, dx: size / 2 - cx * scale, dy: size / 2 - cy * scale };
}

function renderPng(size: number, spec: IconSpec): Buffer {
  const c = new Canvas(size);
  const pine = hex(PACK_COLORS.pine);
  const canvas = hex(PACK_COLORS.canvas);
  const radius = spec.tile === 'rounded' ? (APP_ICON.radius / APP_ICON.box) * size : 0.0001;
  c.fill(flatten(roundedRect(0, 0, size, size, radius)).map((p) => p.points), pine);
  const { scale, dx, dy } = placePack(size, spec.placement);
  const stroke = (s: PackStroke, color: Rgb): void => {
    for (const line of flatten(s.d)) c.stroke(transform(line.points, scale, dx, dy), s.width * scale, color);
  };
  stroke(PACK_HANDLE, canvas);
  const b = PACK_BODY;
  c.fill(flatten(roundedRect(b.x, b.y, b.width, b.height, b.rx)).map((p) => transform(p.points, scale, dx, dy)), canvas);
  stroke(PACK_FLAP, pine);
  stroke(PACK_STRAP, pine);
  return c.png();
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The same drawing as SVG: the artboard's own markup on a 64-unit box. */
function renderSvg(spec: IconSpec): string {
  const box = APP_ICON.box;
  const { scale, dx, dy } = placePack(box, spec.placement);
  const b = PACK_BODY;
  const tile =
    spec.tile === 'rounded'
      ? `<rect width="${box}" height="${box}" rx="${APP_ICON.radius}" fill="${PACK_COLORS.pine}"/>`
      : `<rect width="${box}" height="${box}" fill="${PACK_COLORS.pine}"/>`;
  const place = scale === 1 ? `translate(${r3(dx)} ${r3(dy)})` : `translate(${r3(dx)} ${r3(dy)}) scale(${r3(scale)})`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" role="img" aria-label="Skeuos">` +
    tile +
    `<g transform="${place}">` +
    `<path d="${PACK_HANDLE.d}" fill="none" stroke="${PACK_COLORS.canvas}" stroke-width="${PACK_HANDLE.width}" stroke-linecap="round"/>` +
    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${b.rx}" fill="${PACK_COLORS.canvas}"/>` +
    `<path d="${PACK_FLAP.d}" fill="none" stroke="${PACK_COLORS.pine}" stroke-width="${PACK_FLAP.width}" stroke-linecap="round"/>` +
    `<path d="${PACK_STRAP.d}" fill="none" stroke="${PACK_COLORS.pine}" stroke-width="${PACK_STRAP.width}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g></svg>\n`
  );
}

const root = new URL('../public/', import.meta.url);
mkdirSync(new URL('icons/', root), { recursive: true });

const TILE: IconSpec = { tile: 'rounded', placement: 'design' };
const MASKABLE: IconSpec = { tile: 'full', placement: 'safe' };
const IOS: IconSpec = { tile: 'full', placement: 'design' };

const pngs: Record<string, { size: number; spec: IconSpec }> = {
  'icons/icon-192.png': { size: 192, spec: TILE },
  'icons/icon-512.png': { size: 512, spec: TILE },
  'icons/icon-maskable-512.png': { size: 512, spec: MASKABLE },
  'icons/apple-touch-icon.png': { size: 180, spec: IOS },
  'icons/favicon-32.png': { size: 32, spec: TILE },
};
for (const [file, { size, spec }] of Object.entries(pngs)) writeFileSync(new URL(file, root), renderPng(size, spec));

writeFileSync(new URL('favicon.svg', root), renderSvg(TILE));
writeFileSync(new URL('icons/icon.svg', root), renderSvg(TILE));
writeFileSync(new URL('icons/icon-maskable.svg', root), renderSvg(MASKABLE));

console.log('Wrote favicon.svg and', [...Object.keys(pngs), 'icons/icon.svg', 'icons/icon-maskable.svg'].join(', '));
