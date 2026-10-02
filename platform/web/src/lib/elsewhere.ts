/**
 * The same search, run on sites Skeuos does not copy listings from.
 *
 * sources.search_template holds a search URL for each site that has one.
 * Facebook Marketplace and Craigslist are deep-link only (0002, 0019), and a
 * site whose terms hold its lots back (HiBid) can still be searched by the
 * buyer in their own browser. These links only open that search: nothing is
 * fetched from those sites, here or on the server.
 *
 * Placeholders a template may hold:
 *   {query}      the buyer's words (required: without it there is no search)
 *   {max_price}  whole dollars; the parameter is dropped when there is no cap
 *   {region}     the Craigslist site nearest the search's origin
 *   {location}   a Facebook city path segment; dropped, so Facebook uses the
 *                location the buyer set there
 */
import { haversineMiles, type LatLon } from './distance';

export interface ElsewhereSource {
  readonly slug: string | null;
  readonly name: string;
  readonly searchTemplate: string;
}

export interface ElsewhereOrigin extends LatLon {
  readonly zip: string;
}

export interface ElsewhereOptions {
  /** The words to search for, from elsewhereWords(). */
  readonly words: string;
  readonly maxCents: number | null;
  /** Where the search is centred; null when it has no place. */
  readonly origin: ElsewhereOrigin | null;
  /** The search radius; null for "anywhere". */
  readonly radiusMiles: number | null;
}

export interface ElsewhereLink {
  readonly key: string;
  readonly name: string;
  /** The Craigslist site chosen ("Madison"), or null. */
  readonly place: string | null;
  readonly href: string;
}

export interface CraigslistSite extends LatLon {
  readonly slug: string;
  readonly name: string;
}

/** Craigslist's sites in Wisconsin and the metro areas around it, at their main city. */
export const CRAIGSLIST_SITES: readonly CraigslistSite[] = [
  { slug: 'appleton', name: 'Appleton-Oshkosh-FDL', lat: 44.2619, lon: -88.4154 },
  { slug: 'eauclaire', name: 'Eau Claire', lat: 44.8113, lon: -91.4985 },
  { slug: 'greenbay', name: 'Green Bay', lat: 44.5133, lon: -88.0133 },
  { slug: 'janesville', name: 'Janesville', lat: 42.6828, lon: -89.0187 },
  { slug: 'racine', name: 'Kenosha-Racine', lat: 42.6497, lon: -87.8504 },
  { slug: 'lacrosse', name: 'La Crosse', lat: 43.8014, lon: -91.2396 },
  { slug: 'madison', name: 'Madison', lat: 43.0731, lon: -89.4012 },
  { slug: 'milwaukee', name: 'Milwaukee', lat: 43.0389, lon: -87.9065 },
  { slug: 'northernwi', name: 'Northern WI', lat: 45.6366, lon: -89.4121 },
  { slug: 'sheboygan', name: 'Sheboygan', lat: 43.7508, lon: -87.7145 },
  { slug: 'wausau', name: 'Wausau', lat: 44.9591, lon: -89.6301 },
  { slug: 'chicago', name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { slug: 'rockford', name: 'Rockford', lat: 42.2711, lon: -89.094 },
  { slug: 'dubuque', name: 'Dubuque', lat: 42.5006, lon: -90.6646 },
  { slug: 'quadcities', name: 'Quad Cities', lat: 41.5236, lon: -90.5776 },
  { slug: 'duluth', name: 'Duluth-Superior', lat: 46.7867, lon: -92.1005 },
  { slug: 'minneapolis', name: 'Minneapolis-St Paul', lat: 44.9778, lon: -93.265 },
  { slug: 'rmn', name: 'Rochester, MN', lat: 44.0121, lon: -92.4802 },
  { slug: 'up', name: 'Upper Peninsula', lat: 46.5436, lon: -87.3954 },
];

/** Beyond this, the nearest site listed here is not the buyer's: no Craigslist link rather than a wrong one. */
const CRAIGSLIST_REACH_MILES = 120;

export function nearestCraigslist(at: LatLon | null): CraigslistSite | null {
  if (!at) return null;
  let best: CraigslistSite | null = null;
  let bestMiles = Infinity;
  for (const site of CRAIGSLIST_SITES) {
    const miles = haversineMiles(at, site);
    if (miles < bestMiles) {
      best = site;
      bestMiles = miles;
    }
  }
  return bestMiles <= CRAIGSLIST_REACH_MILES ? best : null;
}

/**
 * The words to hand another site: the parser's websearch string without its
 * exclusions ("-parts", -"power steering") or quotes, which those sites read
 * differently or not at all.
 */
export function elsewhereWords(websearchQuery: string): string {
  return websearchQuery
    .replace(/(^|\s)-("[^"]*"|\S+)/g, ' ')
    .replace(/["“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One link per source whose template can be filled; the order of `sources` is kept. */
export function elsewhereLinks(sources: readonly ElsewhereSource[], options: ElsewhereOptions): ElsewhereLink[] {
  const words = options.words.trim();
  if (!words) return [];
  const out: ElsewhereLink[] = [];
  for (const source of sources) {
    let template = source.searchTemplate.trim();
    if (!template.includes('{query}')) continue;
    let place: string | null = null;
    if (template.includes('{region}')) {
      const site = nearestCraigslist(options.origin);
      if (!site) continue;
      template = template.replaceAll('{region}', site.slug);
      place = site.name;
    }
    template = template.replaceAll('/{location}', '').replaceAll('{location}', '');
    // {query} in the path is filled now; in the query string, below, where
    // URLSearchParams does the encoding.
    const qs = template.indexOf('?');
    template =
      (qs === -1 ? template : template.slice(0, qs)).replaceAll('{query}', encodeURIComponent(words)) +
      (qs === -1 ? '' : template.slice(qs));
    let url: URL;
    try {
      url = new URL(template);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    for (const [key, value] of [...url.searchParams]) {
      if (value === '{query}') url.searchParams.set(key, words);
      else if (value === '{max_price}') {
        if (options.maxCents !== null && options.maxCents > 0) url.searchParams.set(key, String(Math.floor(options.maxCents / 100)));
        else url.searchParams.delete(key);
      }
    }
    // Craigslist narrows a site's results to a distance from a ZIP.
    if (source.slug === 'craigslist' && options.origin && options.radiusMiles !== null) {
      url.searchParams.set('postal', options.origin.zip);
      url.searchParams.set('search_distance', String(Math.round(options.radiusMiles)));
    }
    out.push({ key: source.slug ?? source.name, name: source.name, place, href: url.toString() });
  }
  return out;
}
