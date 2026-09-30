/**
 * Plan names. The database keeps the tiers as free, pro and dealer
 * (user_tier, tier_limits.label 'Free' / 'Pro' / 'Dealer'); the app shows them
 * as Traveler, Outfitter and Quartermaster. Display only: nothing is ever
 * written with these names.
 */
import type { UserTier } from '../data/database.types';

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

/** The next plan up, or null at the top. */
export function nextPlan(tier: UserTier | null | undefined): UserTier | null {
  const i = ORDER.indexOf(tier ?? 'free');
  return i >= 0 && i < ORDER.length - 1 ? (ORDER[i + 1] as UserTier) : null;
}
