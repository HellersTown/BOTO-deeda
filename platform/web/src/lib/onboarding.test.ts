import { parseQuery } from '@platform/query';
import { describe, expect, it } from 'vitest';
import { draftFromParse, huntHasCriteria, toHuntInsert } from './huntDraft';
import {
  capMessage,
  GATHER_CHOICES,
  huntAllowance,
  initialRadius,
  needsOnboarding,
  onboardingHunts,
  toggleChoice,
} from './onboarding';

const OPTS = { userId: 'user-1', homePostalCode: '53202', radiusMiles: 60, slots: null };

describe('"What are you gathering?" choices become hunts through the New Hunt path', () => {
  it('offers the design’s eight choices, in its order', () => {
    expect(GATHER_CHOICES.map((c) => c.label)).toEqual([
      'Tools',
      'Generators and power',
      'Woodstoves and heat',
      'Canning and kitchen',
      'Fencing and livestock',
      'Tractors and implements',
      'Trucks and trailers',
      'Household',
    ]);
  });

  it('makes every choice a hunt the matcher can run: words to search, the home ZIP and the chosen distance', () => {
    const hunts = onboardingHunts(
      GATHER_CHOICES.map((c) => c.key),
      OPTS,
    );
    expect(hunts).toHaveLength(8);
    for (const { choice, insert } of hunts) {
      const parsed = insert.parsed as Record<string, unknown>;
      expect(huntHasCriteria(draftFromParse(parseQuery(choice.query, { homePostalCode: '53202', defaultRadiusMiles: 60 }))), choice.key).toBe(true);
      // 0013 searches with parsed->>'websearchQuery'; 0018 also passes parsed->>'tsquery'.
      expect(String(parsed.websearchQuery).trim(), choice.key).not.toBe('');
      expect(String(parsed.tsquery).trim(), choice.key).not.toBe('');
      expect(insert).toMatchObject({
        user_id: 'user-1',
        name: choice.label,
        query_text: choice.query,
        postal_code: '53202',
        radius_miles: 60,
        category_ids: [],
        active: true,
        notify_immediately: true,
      });
    }
  });

  it('is exactly what the New Hunt page would insert for the same words', () => {
    const [power] = onboardingHunts(['power'], OPTS);
    const byHand = toHuntInsert(draftFromParse(parseQuery('generator or inverter or genset or solar', { homePostalCode: '53202', defaultRadiusMiles: 60 })), {
      userId: 'user-1',
      name: 'Generators and power',
      notifyImmediately: true,
    });
    expect(power?.insert).toEqual(byHand);
    expect((power?.insert.parsed as Record<string, unknown>).websearchQuery).toBe('generator or inverter or genset or solar');
  });

  it('keeps the pick order, drops unknown keys and duplicates', () => {
    const hunts = onboardingHunts(['heat', 'nonsense', 'tools', 'heat'], OPTS);
    expect(hunts.map((h) => h.choice.key)).toEqual(['heat', 'tools']);
  });
});

describe('the plan cap', () => {
  const traveler = { tier: 'free' as const, max_active_hunts: 3, hunts_active: 0, hunts_remaining: 3 };

  it('reads the free slots from v_my_entitlements', () => {
    expect(huntAllowance(traveler, null, 'free')).toEqual({ tier: 'free', max: 3, active: 0, slots: 3 });
    expect(huntAllowance({ ...traveler, hunts_active: 1, hunts_remaining: 2 }, null, 'free').slots).toBe(2);
    expect(huntAllowance({ ...traveler, hunts_active: 5, hunts_remaining: null }, null, 'free').slots).toBe(0);
    expect(huntAllowance({ ...traveler, max_active_hunts: null, hunts_remaining: null }, null, 'free').slots).toBeNull();
  });

  it('falls back to tier_limits for the profile’s plan when the view cannot be read', () => {
    const limits = [
      { tier: 'free' as const, max_active_hunts: 3 },
      { tier: 'pro' as const, max_active_hunts: 25 },
    ];
    expect(huntAllowance(null, limits, 'pro')).toEqual({ tier: 'pro', max: 25, active: 0, slots: 25 });
    expect(huntAllowance(null, limits, null).max).toBe(3);
    expect(huntAllowance(null, null, 'free').slots).toBeNull();
  });

  it('refuses a pick past the cap, and always allows unpicking', () => {
    let picked: string[] = [];
    for (const key of ['tools', 'power', 'heat']) picked = toggleChoice(picked, key, 3).picked;
    const refused = toggleChoice(picked, 'kitchen', 3);
    expect(refused).toEqual({ picked: ['tools', 'power', 'heat'], refused: true });
    expect(toggleChoice(picked, 'power', 3)).toEqual({ picked: ['tools', 'heat'], refused: false });
    expect(toggleChoice(picked, 'kitchen', null).picked).toHaveLength(4);
  });

  it('never creates more hunts than the free slots', () => {
    const hunts = onboardingHunts(['tools', 'power', 'heat', 'kitchen'], { ...OPTS, slots: 2 });
    expect(hunts.map((h) => h.choice.key)).toEqual(['tools', 'power']);
    expect(onboardingHunts(['tools'], { ...OPTS, slots: 0 })).toEqual([]);
  });

  it('says so when the cap is reached, in the plan’s display name', () => {
    const allowance = huntAllowance(traveler, null, 'free');
    expect(capMessage(allowance, 2)).toBeNull();
    expect(capMessage(allowance, 3)).toBe('Traveler keeps watch on 3 hunts at a time. Unpick one to choose another.');
    expect(capMessage(huntAllowance({ ...traveler, hunts_active: 1, hunts_remaining: 2 }, null, 'free'), 2)).toBe(
      'Traveler keeps watch on 3 hunts at a time, and 1 is already running. Unpick one to choose another.',
    );
    expect(capMessage(huntAllowance({ ...traveler, hunts_active: 3, hunts_remaining: 0 }, null, 'free'), 0)).toBe(
      'All 3 hunts on your Traveler plan are already keeping watch. Pause one in Hunts to make room.',
    );
    expect(capMessage(huntAllowance({ tier: 'pro', max_active_hunts: 25, hunts_active: 0, hunts_remaining: 25 }, null, 'pro'), 25)).toMatch(
      /^Outfitter keeps watch on 25 hunts/,
    );
    expect(capMessage({ tier: 'dealer', max: null, active: 0, slots: null }, 8)).toBeNull();
  });
});

describe('when "Before you set out" shows', () => {
  it('shows once, to a profile with no home ZIP that has not been through it', () => {
    expect(needsOnboarding({ home_postal_code: null, onboarded_at: null })).toBe(true);
    expect(needsOnboarding({ home_postal_code: '  ', onboarded_at: null })).toBe(true);
    expect(needsOnboarding({ home_postal_code: '53202', onboarded_at: null })).toBe(false);
    expect(needsOnboarding({ home_postal_code: null, onboarded_at: '2026-09-30T12:00:00+00:00' })).toBe(false);
    expect(needsOnboarding(null)).toBe(false);
  });

  it('preselects the profile’s distance when it is one of the four, else 60', () => {
    expect(initialRadius(100)).toBe(100);
    expect(initialRadius(50)).toBe(60);
    expect(initialRadius(null)).toBe(60);
  });
});
