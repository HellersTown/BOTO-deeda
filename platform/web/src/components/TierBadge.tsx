import type { SourceTier } from '../data/database.types';
import { isGovernment, TIER_LABEL, tierHeadline } from '../lib/tiers';

export function TierBadge({ tier, long = false }: { tier: SourceTier | null | undefined; long?: boolean }) {
  if (!tier) return null;
  return (
    <span className={`tier-badge ${isGovernment(tier) ? 'tier-badge--gov' : 'tier-badge--private'}`}>
      {long ? tierHeadline(tier) : TIER_LABEL[tier]}
    </span>
  );
}
