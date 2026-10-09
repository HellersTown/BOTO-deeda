/**
 * Plan names. The database keeps the tiers as free, pro and dealer
 * (user_tier, tier_limits.label 'Free' / 'Pro' / 'Dealer'); the app shows them
 * as Traveler, Outfitter and Quartermaster. Display only: nothing is ever
 * written with these names.
 */
import type { EntitlementsRow, UserTier } from '../data/database.types';

export const PLAN_NAME: Readonly<Record<UserTier, string>> = {
  free: 'Traveler',
  pro: 'Outfitter',
  dealer: 'Quartermaster',
};

const ORDER: readonly UserTier[] = ['free', 'pro', 'dealer'];

/** A profile with no tier is on the free plan (profiles.tier defaults to 'free'). */
export function planName(tier: UserTier | null | undefined): string {
  return PLAN_NAME[tier ?? 'free'] ?? PLAN_NAME.free;
}

/**
 * No trigger enforces max_watchlist, so the app checks it before a new watch.
 * The sentence to show when every watch slot on the plan is in use; null when
 * there is room, or when the entitlements could not be read (watching still
 * works then). `what` is what the page is about to watch: a lot or a sale.
 */
export function watchlistFullMessage(
  ent: Pick<EntitlementsRow, 'tier' | 'max_watchlist' | 'watchlist_count'> | null,
  what: 'lot' | 'sale',
): string | null {
  if (!ent || ent.max_watchlist === null || (ent.watchlist_count ?? 0) < ent.max_watchlist) return null;
  return `Your ${planName(ent.tier)} plan holds ${ent.max_watchlist} watched lots, and all are in use. Remove one in Bids to watch this ${what}.`;
}

/** The next plan up, or null at the top. */
export function nextPlan(tier: UserTier | null | undefined): UserTier | null {
  const i = ORDER.indexOf(tier ?? 'free');
  return i >= 0 && i < ORDER.length - 1 ? (ORDER[i + 1] as UserTier) : null;
}
