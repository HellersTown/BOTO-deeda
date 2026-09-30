// load-gazetteer: stage one public ZIP-data file in Postgres. Parsing happens in SQL.
//
//   POST /functions/v1/load-gazetteer?file=census_zcta_gazetteer_2023
//   POST /functions/v1/load-gazetteer?file=census_zcta_county_rel_2020
//   POST /functions/v1/load-gazetteer?file=geonames_us
//   then (service role):  select load_postal_codes_from_staging();
//
//   POST /functions/v1/load-gazetteer?file=census_places_2023
//   POST /functions/v1/load-gazetteer?file=census_cousubs_2023
//   then (service role):  select load_places_from_staging();   (migration 0017)
//
// WHY SO LITTLE HAPPENS HERE. Version 1 parsed all three files in this function
// and was killed by the Edge runtime ("CPU Time exceeded", 7 s in, after writing
// 20,000 of ~41,000 rows). Edge Functions have a small per-request CPU budget.
// So this version only downloads, unzips, and hands raw text to Postgres in
// ~1 MB chunks, which costs almost no CPU. The parsing, joining and upserting is
// one SQL function, load_postal_codes_from_staging (migration 0012), which runs
// in a single transaction and refuses a partial load.
//
// Sources, and why each one:
//   census_zcta_gazetteer_2023   Census ZCTA internal points (public domain):
//                                the coordinates radius search measures from.
//   census_zcta_county_rel_2020  Census ZCTA-to-county file (public domain): the
//                                state and county; a ZCTA that straddles counties
//                                takes the one holding the most land.
//   geonames_us                  GeoNames US postal codes (CC BY 4.0, attribution
//                                required): city names, plus PO-box and
//                                single-organisation ZIPs that have no Census
//                                geography but that federal facilities often use.
//   census_places_2023           Census places: incorporated cities and villages
//                                and CDPs, with internal points (public domain).
//   census_cousubs_2023          Census county subdivisions: Wisconsin's towns
//                                (public domain). With places, these name the
//                                municipalities that postal city names lump
//                                together (every Wauwatosa ZIP is "Milwaukee").
//
// National rather than Wisconsin-only: radius search from a border town
// (Beloit, Superior, Marinette, La Crosse, Kenosha) must reach the next state.
//
// Politeness: a file staged in the last 24 hours is not downloaded again, and
// no file is downloaded once the table it feeds is fully loaded, however often
// this public URL is called.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { unzipSync, strFromU8 } from 'npm:fflate@0.8.2';
import { CRAWLER_UA } from './lib/http.ts';

// `table` + `loaded` say when a file is no longer needed: once the table it feeds
// holds that many rows, the file is not downloaded again.
const FILES: Record<string, { url: string; entry?: (name: string) => boolean; table: string; loaded: number }> = {
  census_zcta_gazetteer_2023: {
    url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip',
    entry: (n) => n.toLowerCase().endsWith('.txt'),
    table: 'postal_codes',
    loaded: 40_000,
  },
  census_zcta_county_rel_2020: {
    url: 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt',
    table: 'postal_codes',
    loaded: 40_000,
  },
  geonames_us: {
    url: 'https://download.geonames.org/export/zip/US.zip',
    entry: (n) => n === 'US.txt',
    table: 'postal_codes',
    loaded: 40_000,
  },
  census_places_2023: {
    url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip',
    entry: (n) => n.toLowerCase().endsWith('.txt'),
    table: 'places',
    loaded: 60_000,
  },
  census_cousubs_2023: {
    url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_cousubs_national.zip',
    entry: (n) => n.toLowerCase().endsWith('.txt'),
    table: 'places',
    loaded: 60_000,
  },
};

const CHUNK_CHARS = 1_000_000;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  (JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>).default;

Deno.serve(async (req) => {
  const started = Date.now();
  const name = new URL(req.url).searchParams.get('file') ?? '';
  const spec = FILES[name];
  if (!spec) {
    return Response.json({ error: `file must be one of: ${Object.keys(FILES).join(', ')}` }, { status: 400 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { count } = await db.from(spec.table).select('*', { count: 'exact', head: true });
  if ((count ?? 0) >= spec.loaded) {
    return Response.json({ skipped: true, reason: `${spec.table} already holds ${count} rows` });
  }
  const { data: staged } = await db.rpc('staged_files');
  const prior = (staged ?? []).find((s: { name: string }) => s.name === name);
  if (prior && Date.now() - new Date(prior.fetched_at).getTime() < 24 * 3600_000) {
    return Response.json({ skipped: true, reason: `${name} staged at ${prior.fetched_at}`, parts: prior.parts });
  }

  const res = await fetch(spec.url, {
    headers: { 'User-Agent': CRAWLER_UA, Accept: '*/*' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return Response.json({ error: `${new URL(spec.url).host} returned HTTP ${res.status}` }, { status: 502 });
  const bytes = new Uint8Array(await res.arrayBuffer());

  let text: string;
  if (spec.entry) {
    // Decompress only the entry we need (GeoNames also ships a readme).
    const files = unzipSync(bytes, { filter: (f) => spec.entry!(f.name) });
    const entry = Object.keys(files)[0];
    if (!entry) return Response.json({ error: 'expected entry not found in zip' }, { status: 502 });
    text = strFromU8(files[entry]);
  } else {
    text = new TextDecoder().decode(bytes);
  }

  const { error: resetErr } = await db.rpc('stage_file_reset', { p_name: name });
  if (resetErr) return Response.json({ error: `stage_file_reset: ${resetErr.message}` }, { status: 500 });

  // Split at line boundaries so no record is cut across two chunks.
  let part = 0;
  for (let pos = 0; pos < text.length; ) {
    let end = Math.min(pos + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > pos) end = nl + 1;
    }
    const { error } = await db.rpc('stage_file_part', { p_name: name, p_part: part, p_body: text.slice(pos, end) });
    if (error) return Response.json({ error: `stage_file_part ${part}: ${error.message}` }, { status: 500 });
    part++;
    pos = end;
  }

  return Response.json({ file: name, bytes: bytes.length, chars: text.length, parts: part, ms: Date.now() - started });
});
