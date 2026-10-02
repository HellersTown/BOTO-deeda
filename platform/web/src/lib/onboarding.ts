/**
 * "Before you set out" (Onboard.dc.html): the home ZIP, how far to travel, and
 * what the user is gathering. Each picked choice becomes a hunt, made the way
 * the New Hunt page makes one (parseQuery, draftFromParse, toHuntInsert), and
 * never more than the plan lets run at once.
 */
import { parseQuery } from '@platform/query';
import type { EntitlementsRow, HuntInsert, ProfileRow, TierLimitsRow, UserTier } from '../data/database.types';
import { draftFromParse, toHuntInsert } from './huntDraft';
import { planName } from './plans';

export interface GatherChoice {
  readonly key: string;
  /** The chip, and the new hunt's name. */
  readonly label: string;
  /**
   * What the hunt looks for, as a person would type it. Each is one either-or
   * list of words sellers put in titles, which the parser keeps as a single
   * group: generic labels ("tools", "furniture") are dropped by the parser
   * because titles rarely carry them.
   */
  readonly query: string;
}

export const GATHER_CHOICES: readonly GatherChoice[] = [
  { key: 'tools', label: 'Tools', query: 'wrench or socket set or drill or saw or grinder or welder or compressor or toolbox' },
  { key: 'power', label: 'Generators and power', query: 'generator or inverter or genset or solar' },
  { key: 'heat', label: 'Woodstoves and heat', query: 'wood stove or woodstove or pellet stove or kerosene heater or space heater' },
  { key: 'kitchen', label: 'Canning and kitchen', query: 'canner or canning or dehydrator or cast iron or dutch oven or stockpot' },
  { key: 'livestock', label: 'Fencing and livestock', query: 'fencing or fence or cattle gate or corral or livestock' },
  { key: 'tractors', label: 'Tractors and implements', query: 'tractor or implement or brush hog or tiller or plow or baler' },
  { key: 'trucks', label: 'Trucks and trailers', query: 'truck or trailer' },
  {
    key: 'household',
    label: 'Household',
    query: 'household or dresser or sofa or refrigerator or freezer or washer or dryer or dishes',
  },
];

/** The design's four distances. */
export const ONBOARDING_RADII: readonly number[] = [25, 60, 100, 200];
export const DEFAULT_ONBOARDING_RADIUS = 60;

/** The distance to preselect: the profile's own when it is one of the four, else 60 (the design's). */
export function initialRadius(current: number | null | undefined): number {
  return current !== null && current !== undefined && ONBOARDING_RADII.includes(current) ? current : DEFAULT_ONBOARDING_RADIUS;
}

/**
 * Show "Before you set out" once, after sign-in: to a profile with no home ZIP
 * that has not been through it (profiles.onboarded_at, which 0009 lets the user
 * write, is set when they finish or skip).
 */
export function needsOnboarding(profile: Pick<ProfileRow, 'home_postal_code' | 'onboarded_at'> | null | undefined): boolean {
  if (!profile) return false;
  return !profile.home_postal_code?.trim() && !profile.onboarded_at;
}

export interface HuntAllowance {
  readonly tier: UserTier;
  /** The plan's cap on active hunts; null when there is none (or it could not be read). */
  readonly max: number | null;
  /** Active hunts already running. */
  readonly active: number;
  /** How many more can start now; null when no cap is known. */
  readonly slots: number | null;
}

/**
 * How many hunts can start now: v_my_entitlements first (the plan and its use,
 * 0004), else the plan's row in tier_limits, assuming none are running yet. The
 * hunts trigger (0003) enforces the cap either way; this only keeps the page
 * from offering more than it can start.
 */
export function huntAllowance(
  ent: Pick<EntitlementsRow, 'tier' | 'max_active_hunts' | 'hunts_active' | 'hunts_remaining'> | null | undefined,
  limits: readonly Pick<TierLimitsRow, 'tier' | 'max_active_hunts'>[] | null | undefined,
  tier: UserTier | null | undefined,
): HuntAllowance {
  if (ent) {
    const planTier = ent.tier ?? tier ?? 'free';
    const active = ent.hunts_active ?? 0;
    const max = ent.max_active_hunts;
    if (max === null) return { tier: planTier, max: null, active, slots: null };
    return { tier: planTier, max, active, slots: Math.max(0, ent.hunts_remaining ?? max - active) };
  }
  const planTier = tier ?? 'free';
  const row = limits?.find((l) => l.tier === planTier);
  if (row && row.max_active_hunts !== null) return { tier: planTier, max: row.max_active_hunts, active: 0, slots: row.max_active_hunts };
  return { tier: planTier, max: null, active: 0, slots: null };
}

/** Pick or unpick a choice. A new pick past the free slots is refused. */
export function toggleChoice(picked: readonly string[], key: string, slots: number | null): { picked: string[]; refused: boolean } {
  if (picked.includes(key)) return { picked: picked.filter((k) => k !== key), refused: false };
  if (slots !== null && picked.length >= slots) return { picked: [...picked], refused: true };
  return { picked: [...picked, key], refused: false };
}

/** What to say once the plan's cap is reached; null while there is room. */
export function capMessage(allowance: HuntAllowance, pickedCount: number): string | null {
  if (allowance.slots === null || allowance.max === null) return null;
  const plan = planName(allowance.tier);
  if (allowance.slots === 0) {
    return `All ${allowance.max} hunts on your ${plan} plan are already keeping watch. Pause one in Hunts to make room.`;
  }
  if (pickedCount < allowance.slots) return null;
  const running = allowance.active > 0 ? `, and ${allowance.active} ${allowance.active === 1 ? 'is' : 'are'} already running` : '';
  return `${plan} keeps watch on ${allowance.max} ${allowance.max === 1 ? 'hunt' : 'hunts'} at a time${running}. Unpick one to choose another.`;
}

export interface OnboardingHunt {
  readonly choice: GatherChoice;
  readonly insert: HuntInsert;
}

/**
 * The hunts to create for the picked choices, in the order they were picked,
 * through the New Hunt page's own path. Picks past `slots` are dropped.
 */
export function onboardingHunts(
  picked: readonly string[],
  options: { readonly userId: string; readonly homePostalCode: string; readonly radiusMiles: number; readonly slots: number | null },
): OnboardingHunt[] {
  const chosen = picked
    .map((key) => GATHER_CHOICES.find((c) => c.key === key))
    .filter((c): c is GatherChoice => c !== undefined);
  const unique = chosen.filter((c, i) => chosen.findIndex((d) => d.key === c.key) === i);
  const capped = options.slots === null ? unique : unique.slice(0, Math.max(0, options.slots));
  return capped.map((choice) => {
    const parse = parseQuery(choice.query, { homePostalCode: options.homePostalCode, defaultRadiusMiles: options.radiusMiles });
    return {
      choice,
      insert: toHuntInsert(draftFromParse(parse), { userId: options.userId, name: choice.label, notifyImmediately: true }),
    };
  });
}
