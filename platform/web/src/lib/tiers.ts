/** Source tiers (the source_tier enum, 0002) in the words the UI uses. */
import type { SourceTier } from '../data/database.types';

export const TIER_LABEL: Readonly<Record<SourceTier, string>> = {
  federal: 'Federal',
  state: 'State',
  county: 'County',
  municipal: 'City',
  school: 'School',
  private: 'Private',
  estate: 'Estate sale',
  wholesale: 'Wholesale',
  marketplace: 'Marketplace',
  dealer: 'Dealer',
};

export const GOVERNMENT_TIERS: ReadonlySet<SourceTier> = new Set(['federal', 'state', 'county', 'municipal', 'school']);

export function isGovernment(tier: SourceTier | null | undefined): boolean {
  return tier !== null && tier !== undefined && GOVERNMENT_TIERS.has(tier);
}

/** "Federal surplus", "County surplus", "Estate sale": the lot page's seller line. */
export function tierHeadline(tier: SourceTier | null | undefined): string | null {
  if (!tier) return null;
  return isGovernment(tier) ? `${TIER_LABEL[tier]} surplus` : TIER_LABEL[tier];
}

export type SellerGroupKey = 'federal' | 'state' | 'county' | 'school' | 'private' | 'estate';

export interface SellerGroup {
  readonly key: SellerGroupKey;
  readonly label: string;
  readonly tiers: readonly SourceTier[];
}

/** The desktop sidebar's seller checkboxes and the tiers each one stands for. */
export const SELLER_GROUPS: readonly SellerGroup[] = [
  { key: 'federal', label: 'Federal', tiers: ['federal'] },
  { key: 'state', label: 'State', tiers: ['state'] },
  { key: 'county', label: 'County and city', tiers: ['county', 'municipal'] },
  { key: 'school', label: 'Schools', tiers: ['school'] },
  { key: 'private', label: 'Private auctioneers', tiers: ['private'] },
  { key: 'estate', label: 'Estate sales', tiers: ['estate'] },
];

/** Tiers no checkbox covers. They are searched only when there is no seller filter at all. */
export const UNGROUPED_TIERS: readonly SourceTier[] = ['wholesale', 'marketplace', 'dealer'];
