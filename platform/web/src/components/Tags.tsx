/**
 * The signature pieces from Kit.dc.html: the ink luggage-tag price, the mono
 * seller tag, the brass "Worth the trip" badge and the trail-marked distance.
 */
import type { SourceTier } from '../data/database.types';
import { distanceTag, distanceWords } from '../lib/distance';
import { formatCentsShort } from '../lib/money';
import { isGovernment, TIER_LABEL, TIER_TAG } from '../lib/tiers';
import { TrailIcon } from './Icons';

/**
 * Show "Worth the trip" from this sleeper score (0-10, compute_sleeper in
 * 0006). A design threshold: a thin description, little bidding and enough
 * photos to judge it together reach about 6.
 */
export const WORTH_THE_TRIP_MIN_SCORE = 5;

export function isWorthTheTrip(sleeperScore: number | null | undefined): boolean {
  return sleeperScore !== null && sleeperScore !== undefined && sleeperScore >= WORTH_THE_TRIP_MIN_SCORE;
}

/** The ink luggage tag: a mono price with a small canvas dot and a rounded left end. */
export function PriceTag({ cents, size = 'md', className = '' }: { cents: number; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return <span className={`price-tag price-tag--${size} ${className}`.trim()}>{formatCentsShort(cents)}</span>;
}

/** The seller in mono caps: pine for public sellers, muted for private, estate and the rest. */
export function TierTag({ tier }: { tier: SourceTier | null | undefined }) {
  if (!tier) return null;
  return (
    <span className={`tier-tag ${isGovernment(tier) ? 'tier-tag--public' : 'tier-tag--private'}`} title={TIER_LABEL[tier]}>
      {TIER_TAG[tier]}
    </span>
  );
}

export function WorthTheTrip({ className = '' }: { className?: string }) {
  return <span className={`worth ${className}`.trim()}>Worth the trip</span>;
}

/** "1.4 MI" in mono caps with the trail; "≈ 18 MI" when measured from a city's centroid. */
export function DistanceTag({ miles, approximate = false }: { miles: number; approximate?: boolean }) {
  return (
    <span className="distance">
      <TrailIcon size={13} strokeWidth={2.2} />
      <span className="distance__miles" aria-hidden="true">
        {distanceTag(miles, approximate)}
      </span>
      <span className="visually-hidden">{distanceWords(miles, approximate)}</span>
    </span>
  );
}
