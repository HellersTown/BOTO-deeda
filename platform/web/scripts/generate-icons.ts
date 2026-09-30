/**
 * Writes the favicon and PWA icons, as SVG and as PNG, from src/brand/jar.ts.
 *
 *   npm run icons      (node --experimental-strip-types scripts/generate-icons.ts)
 *
 * No dependencies: the jar's paths are flattened to polygons, filled with 4 x 4
 * supersampling, and encoded as PNG with node:zlib. PNGs exist because iOS
 * home-screen icons and some install prompts do not accept SVG.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { JAR_BAND, JAR_BODY, JAR_BOX, JAR_COLORS, JAR_GLAZE, JAR_LIP } from '../src/brand/jar.ts';

type Point = readonly [number, number];
type Rgb = readonly [number, number, number];

// ------------------------------------------------------------------- geometry

/** Absolute M/L/C/Z path to closed polygons, cubic curves flattened. */
function flatten(d: string, steps = 24): Point[][] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? [];
  const polys: Point[][] = [];
  let current: Point[] = [];
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      if (current.length) polys.push(current);
      current = [[num(), num()]];
    } else if (cmd === 'L') {
      current.push([num(), num()]);
    } else if (cmd === 'C') {
      const [x0, y0] = current[current.length - 1] as Point;
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        current.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
    } else if (cmd === 'Z') {
      if (current.length) polys.push(current);
      current = [];
    } else {
      throw new Error(`Unsupported path token ${cmd}`);
    }
  }
  if (current.length) polys.push(current);
  return polys;
}

function transform(polys: Point[][], scale: number, dx: number, dy: number): Point[][] {
  return polys.map((p) => p.map(([x, y]) => [x * scale + dx, y * scale + dy] as Point));
}

/** A rounded rectangle as a path, corners drawn with cubic quarter-circles. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = 0.5523 * r;
  return [
    `M${x + r} ${y}`, `L${x + w - r} ${y}`, `C${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r}`,
    `L${x + w} ${y + h - r}`, `C${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h}`,
    `L${x + r} ${y + h}`, `C${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r}`,
    `L${x} ${y + r}`, `C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}`, 'Z',
  ].join(' ');
}

// ------------------------------------------------------------------ raster

const SS = 4; // 4 x 4 samples per pixel

class Canvas {
  readonly size: number;
  readonly data: Float64Array;
  constructor(size: number) {
    this.size = size;
    this.data = new Float64Array(size * size * 4);
  }

  fill(polys: Point[][], [r, g, b]: Rgb): void {
    const n = this.size;
    const coverage = new Float64Array(n * n);
    const edges = polys.flatMap((p) => p.map((a, j) => [a, p[(j + 1) % p.length] as Point] as const));
    for (let sy = 0; sy < n * SS; sy++) {
      const y = (sy + 0.5) / SS;
      const xs: number[] = [];
      for (const [[x0, y0], [x1, y1]] of edges) {
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      const row = Math.floor(sy / SS) * n;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k] as number) * SS - 0.5));
        const to = Math.min(n * SS - 1, Math.floor((xs[k + 1] as number) * SS - 0.5));
        for (let sx = from; sx <= to; sx++) coverage[row + Math.floor(sx / SS)] += 1 / (SS * SS);
      }
    }
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
  readonly size: number;
  /** 'rounded': a rounded tile; 'full': full bleed (maskable, iOS); 'none': transparent. */
  readonly background: 'rounded' | 'full' | 'none';
  /** Jar height as a share of the canvas. */
  readonly jar: number;
}

/** The jar spans y 2..22 and x 4.25..19.75 in its box; centre it optically. */
function jarPlacement(size: number, share: number): { scale: number; dx: number; dy: number } {
  const scale = (size * share) / 20;
  return { scale, dx: size / 2 - 12 * scale, dy: size / 2 - 12 * scale };
}

function renderPng(spec: IconSpec): Buffer {
  const c = new Canvas(spec.size);
  const ground = hex(JAR_COLORS.ground);
  if (spec.background === 'full') c.fill(flatten(roundedRect(0, 0, spec.size, spec.size, 0.001)), ground);
  if (spec.background === 'rounded') c.fill(flatten(roundedRect(0, 0, spec.size, spec.size, spec.size * 0.22)), ground);
  const { scale, dx, dy } = jarPlacement(spec.size, spec.jar);
  c.fill(transform(flatten(JAR_BODY), scale, dx, dy), hex(JAR_COLORS.body));
  c.fill(transform(flatten(JAR_LIP), scale, dx, dy), hex(JAR_COLORS.lip));
  c.fill(transform(flatten(JAR_BAND), scale, dx, dy), hex(JAR_COLORS.lip));
  c.fill(transform(flatten(JAR_GLAZE), scale, dx, dy), hex(JAR_COLORS.glaze));
  return c.png();
}

function renderSvg(spec: Omit<IconSpec, 'size'> & { readonly box: number }): string {
  const { scale, dx, dy } = jarPlacement(spec.box, spec.jar);
  const bg =
    spec.background === 'full'
      ? `<rect width="${spec.box}" height="${spec.box}" fill="${JAR_COLORS.ground}"/>`
      : spec.background === 'rounded'
        ? `<rect width="${spec.box}" height="${spec.box}" rx="${spec.box * 0.22}" fill="${JAR_COLORS.ground}"/>`
        : '';
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.box} ${spec.box}" role="img" aria-label="Skeuos">` +
    bg +
    `<g transform="translate(${r(dx)} ${r(dy)}) scale(${r(scale)})">` +
    `<path d="${JAR_BODY}" fill="${JAR_COLORS.body}"/>` +
    `<path d="${JAR_LIP}" fill="${JAR_COLORS.lip}"/>` +
    `<path d="${JAR_BAND}" fill="${JAR_COLORS.lip}"/>` +
    `<path d="${JAR_GLAZE}" fill="${JAR_COLORS.glaze}"/>` +
    `</g></svg>\n`
  );
}

const root = new URL('../public/', import.meta.url);
mkdirSync(new URL('icons/', root), { recursive: true });

const pngs: Record<string, IconSpec> = {
  'icons/icon-192.png': { size: 192, background: 'rounded', jar: 0.66 },
  'icons/icon-512.png': { size: 512, background: 'rounded', jar: 0.66 },
  'icons/icon-maskable-512.png': { size: 512, background: 'full', jar: 0.54 },
  'icons/apple-touch-icon.png': { size: 180, background: 'full', jar: 0.62 },
  'icons/favicon-32.png': { size: 32, background: 'none', jar: 0.94 },
};
for (const [file, spec] of Object.entries(pngs)) writeFileSync(new URL(file, root), renderPng(spec));

writeFileSync(new URL('favicon.svg', root), renderSvg({ box: JAR_BOX, background: 'none', jar: 0.94 }));
writeFileSync(new URL('icons/icon.svg', root), renderSvg({ box: 512, background: 'rounded', jar: 0.66 }));
writeFileSync(new URL('icons/icon-maskable.svg', root), renderSvg({ box: 512, background: 'full', jar: 0.54 }));

console.log('Wrote favicon.svg and', [...Object.keys(pngs), 'icons/icon.svg', 'icons/icon-maskable.svg'].join(', '));
