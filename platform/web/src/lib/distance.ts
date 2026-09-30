/** Great-circle miles between two points (search_lots measures the same way, from ZIP centroids). */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(a: LatLon, b: LatLon): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  const miles = 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(miles * 10) / 10;
}

/** "1.4 mi", "38 mi", "1,204 mi". */
export function formatMiles(miles: number): string {
  const rounded = miles < 10 ? Math.round(miles * 10) / 10 : Math.round(miles);
  return `${rounded.toLocaleString('en-US')} mi`;
}
