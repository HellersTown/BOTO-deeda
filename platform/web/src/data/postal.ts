/**
 * postal_codes: the ZIP gazetteer. 0003 makes it world-readable (anon and
 * authenticated), so a ZIP can be validated before it is saved, and ZIP
 * centroids give a distance where search_lots did not supply one.
 */
import { toDataError } from './errors';
import { db } from './supabase';

export interface PostalPlace {
  readonly postalCode: string;
  readonly city: string | null;
  readonly state: string;
  readonly lat: number;
  readonly lon: number;
}

export const ZIP_PATTERN = /^\d{5}$/;

/** Five digits, or null. ZIP+4 is cut to the five-digit key the gazetteer uses (as 0007 does). */
export function normalizeZip(input: string): string | null {
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(input);
  return m ? (m[1] ?? null) : null;
}

export async function lookupPostalCode(zip: string): Promise<PostalPlace | null> {
  const found = await lookupPostalCodes([zip]);
  return found.get(zip) ?? null;
}

export async function lookupPostalCodes(zips: readonly string[]): Promise<Map<string, PostalPlace>> {
  const wanted = [...new Set(zips.filter((z) => ZIP_PATTERN.test(z)))];
  const out = new Map<string, PostalPlace>();
  if (wanted.length === 0) return out;
  const { data, error } = await db()
    .from('postal_codes')
    .select('postal_code, city, state, lat, lon')
    .in('postal_code', wanted);
  if (error) throw toDataError(error, 'postal_codes');
  for (const row of data ?? []) {
    out.set(row.postal_code, { postalCode: row.postal_code, city: row.city, state: row.state, lat: row.lat, lon: row.lon });
  }
  return out;
}

export interface PlaceCandidate {
  readonly city: string;
  readonly state: string;
  /** The city's ZIP nearest the centroid of all its ZIPs: a stand-in for "the city". */
  readonly zip: string;
}

/**
 * ZIPs for a place name the parser could not turn into one ("near Madison").
 * The parser never guesses a ZIP, and neither does this: each candidate is a
 * real gazetteer row, one per state that has a city of that name, so an
 * ambiguous name comes back as several choices for the user.
 */
export async function resolvePlace(city: string, state: string | null): Promise<PlaceCandidate[]> {
  const pattern = city.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  if (pattern === '') return [];
  let query = db().from('postal_codes').select('postal_code, city, state, lat, lon').ilike('city', pattern).limit(1000);
  if (state) query = query.eq('state', state);
  const { data, error } = await query;
  if (error) throw toDataError(error, 'place lookup');
  const byState = new Map<string, { postal_code: string; city: string | null; lat: number; lon: number }[]>();
  for (const row of data ?? []) {
    const list = byState.get(row.state) ?? [];
    list.push(row);
    byState.set(row.state, list);
  }
  const out: PlaceCandidate[] = [];
  for (const [st, rows] of byState) {
    const lat = rows.reduce((s, r) => s + r.lat, 0) / rows.length;
    const lon = rows.reduce((s, r) => s + r.lon, 0) / rows.length;
    const best = [...rows].sort(
      (a, b) => (a.lat - lat) ** 2 + (a.lon - lon) ** 2 - ((b.lat - lat) ** 2 + (b.lon - lon) ** 2) || a.postal_code.localeCompare(b.postal_code),
    )[0];
    if (best) out.push({ city: best.city ?? city, state: st, zip: best.postal_code });
  }
  return out.sort((a, b) => a.state.localeCompare(b.state));
}
