/** Great-circle miles between two points (search_lots measures the same way, from ZIP centroids). */
import type { PickupGeoSource } from '../data/database.types';

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

/**
 * 0016: a pickup point found from the city's centroid (no ZIP, no address) is
 * only roughly where the lot is, so a distance measured to it is approximate.
 */
export function isApproximateGeo(source: PickupGeoSource | null | undefined): boolean {
  return source === 'city';
}

/** An approximate distance is stated in whole miles: a decimal would claim a precision it does not have. */
function milesText(miles: number, approximate: boolean): string {
  if (!approximate) return formatMiles(miles);
  return `${Math.max(1, Math.round(miles)).toLocaleString('en-US')} mi`;
}

/** The card and tag form, in caps: "1.4 MI", or "≈ 18 MI" when measured from a city's centroid. */
export function distanceTag(miles: number, approximate = false): string {
  return `${approximate ? '≈ ' : ''}${milesText(miles, approximate)}`.toUpperCase();
}

/** The same distance in words, for screen readers and sentences: "1.4 mi", "about 18 mi". */
export function distanceWords(miles: number, approximate = false): string {
  return `${approximate ? 'about ' : ''}${milesText(miles, approximate)}`;
}

/** The lot page's form: "1.4 mi from 53202", "about 18 mi from 53202". */
export function distanceFrom(miles: number, approximate: boolean, zip: string): string {
  return `${distanceWords(miles, approximate)} from ${zip}`;
}
