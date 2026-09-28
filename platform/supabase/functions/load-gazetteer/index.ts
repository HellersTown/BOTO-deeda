// load-gazetteer: fill postal_codes from public ZIP data, once.
//
// Sources, and why each one:
//   1. Census 2023 ZCTA Gazetteer (public domain): the authoritative coordinates.
//      INTPTLAT/INTPTLONG is the ZCTA's internal point, which is what radius
//      search measures from.
//   2. Census 2020 ZCTA-to-county relationship file (public domain): the state
//      and county. A ZCTA can straddle counties (and occasionally states); we
//      take the county holding the largest land area.
//   3. GeoNames US postal codes (CC BY 4.0, attribution required): the city
//      name, plus ZIPs that are NOT ZCTAs. PO-box and single-organisation ZIPs
//      have no Census geography, and federal and state facilities often use
//      them, so they matter for exactly the government lots we ingest.
//
// National rather than Wisconsin-only, deliberately: radius search from a border
// town (Beloit, Superior, Marinette, La Crosse, Kenosha) must see lots in the
// neighbouring state, and an out-of-state lot's own location needs its ZIP too.
//
// One-shot: refuses to run again once the table is loaded, so the public URL
// cannot be used to make us re-download 10 MB from census.gov on demand.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { unzipSync, strFromU8 } from 'npm:fflate@0.8.2';
import { CRAWLER_UA } from './lib/http.ts';

const GAZ_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip';
const REL_URL = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt';
const GEONAMES_URL = 'https://download.geonames.org/export/zip/US.zip';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  (JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>).default;

// State FIPS -> USPS abbreviation.
const FIPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
  '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
  '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
  '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { 'User-Agent': CRAWLER_UA, Accept: '*/*' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function firstTxt(zip: Uint8Array, prefer?: string): string {
  const files = unzipSync(zip);
  const name = Object.keys(files).find((n) => (prefer ? n === prefer : n.toLowerCase().endsWith('.txt')));
  if (!name) throw new Error(`no .txt entry in zip (entries: ${Object.keys(files).join(', ')})`);
  return strFromU8(files[name]);
}

interface Row {
  postal_code: string;
  city: string | null;
  state: string;
  county: string | null;
  lat: number;
  lon: number;
  source: string;
}

Deno.serve(async () => {
  const started = Date.now();
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { count } = await db.from('postal_codes').select('postal_code', { count: 'exact', head: true });
  if ((count ?? 0) >= 30_000) {
    return Response.json({ skipped: true, reason: `postal_codes already holds ${count} rows` });
  }

  const report: Record<string, unknown> = {};
  const [gazZip, relBytes, geoZip] = await Promise.all([
    download(GAZ_URL),
    download(REL_URL).catch((e) => { report.relationship_error = String(e); return null; }),
    download(GEONAMES_URL).catch((e) => { report.geonames_error = String(e); return null; }),
  ]);

  // 1. Census gazetteer: GEOID ALAND AWATER ALAND_SQMI AWATER_SQMI INTPTLAT INTPTLONG
  const coords = new Map<string, { lat: number; lon: number }>();
  const gazLines = firstTxt(gazZip).split(/\r?\n/);
  const gh = gazLines[0].split('\t').map((h) => h.trim().toUpperCase());
  const [iG, iLat, iLon] = [gh.indexOf('GEOID'), gh.indexOf('INTPTLAT'), gh.indexOf('INTPTLONG')];
  for (let i = 1; i < gazLines.length; i++) {
    const c = gazLines[i].split('\t');
    if (c.length < 7) continue;
    const zip = c[iG].trim();
    const lat = parseFloat(c[iLat]);
    const lon = parseFloat(c[iLon]);
    if (/^\d{5}$/.test(zip) && Number.isFinite(lat) && Number.isFinite(lon)) coords.set(zip, { lat, lon });
  }
  report.census_zctas = coords.size;

  // 2. Relationship file: pick the county with the most land in each ZCTA.
  const place = new Map<string, { state: string; county: string; land: number }>();
  if (relBytes) {
    const lines = new TextDecoder().decode(relBytes).split(/\r?\n/);
    const h = lines[0].split('|').map((x) => x.trim().toUpperCase());
    const iZ = h.indexOf('GEOID_ZCTA5_20');
    const iC = h.indexOf('GEOID_COUNTY_20');
    const iN = h.indexOf('NAMELSAD_COUNTY_20');
    const iA = h.indexOf('AREALAND_PART');
    if ([iZ, iC, iN, iA].some((x) => x < 0)) {
      report.relationship_error = `unexpected header: ${lines[0].slice(0, 200)}`;
    } else {
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split('|');
        const zip = c[iZ]?.trim();
        if (!zip || !/^\d{5}$/.test(zip)) continue;
        const state = FIPS[(c[iC] ?? '').slice(0, 2)];
        if (!state) continue;
        const land = Number(c[iA]) || 0;
        const prev = place.get(zip);
        if (!prev || land > prev.land) place.set(zip, { state, county: c[iN].trim(), land });
      }
    }
    report.relationship_zctas = place.size;
  }

  // 3. GeoNames: country, postal, place, state name, state code, county, ...,
  //    lat (col 9), lon (col 10).
  const names = new Map<string, { city: string; state: string; county: string | null; lat: number; lon: number }>();
  if (geoZip) {
    for (const line of firstTxt(geoZip, 'US.txt').split(/\r?\n/)) {
      const c = line.split('\t');
      if (c.length < 11 || c[0] !== 'US') continue;
      const zip = c[1].trim();
      const lat = parseFloat(c[9]);
      const lon = parseFloat(c[10]);
      if (!/^\d{5}$/.test(zip) || !c[4] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      names.set(zip, { city: c[2].trim(), state: c[4].trim().toUpperCase(), county: c[5]?.trim() || null, lat, lon });
    }
    report.geonames_zips = names.size;
  }

  // Merge. Census geography wins wherever it exists; GeoNames fills the name and
  // the ZIPs Census has no geography for.
  const rows: Row[] = [];
  let noState = 0;
  for (const [zip, pt] of coords) {
    const p = place.get(zip);
    const n = names.get(zip);
    const state = p?.state ?? n?.state;
    if (!state) { noState++; continue; }
    rows.push({
      postal_code: zip,
      city: n?.city ?? null,
      state,
      county: p?.county ?? n?.county ?? null,
      lat: pt.lat,
      lon: pt.lon,
      source: p ? 'census_zcta_2023' : 'census_zcta_2023+geonames_state',
    });
  }
  let geonamesOnly = 0;
  for (const [zip, n] of names) {
    if (coords.has(zip)) continue;
    geonamesOnly++;
    rows.push({ postal_code: zip, city: n.city, state: n.state, county: n.county, lat: n.lat, lon: n.lon, source: 'geonames' });
  }
  report.zctas_without_state = noState;
  report.geonames_only_zips = geonamesOnly;

  let written = 0;
  for (let i = 0; i < rows.length; i += 5000) {
    const { error } = await db.from('postal_codes').upsert(rows.slice(i, i + 5000), { onConflict: 'postal_code' });
    if (error) return Response.json({ error: `upsert at ${i}: ${error.message}`, report }, { status: 500 });
    written += Math.min(5000, rows.length - i);
  }

  report.written = written;
  report.wisconsin = rows.filter((r) => r.state === 'WI').length;
  report.ms = Date.now() - started;
  return Response.json(report);
});
