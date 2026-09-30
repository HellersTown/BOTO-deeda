import { describe, expect, it } from 'vitest';
import { nextPlan, PLAN_NAME, planName } from './plans';

describe('plan display names', () => {
  it('shows free, pro and dealer as Traveler, Outfitter and Quartermaster', () => {
    expect(PLAN_NAME).toEqual({ free: 'Traveler', pro: 'Outfitter', dealer: 'Quartermaster' });
    expect(planName('free')).toBe('Traveler');
    expect(planName('pro')).toBe('Outfitter');
    expect(planName('dealer')).toBe('Quartermaster');
  });

  it('treats a missing tier as the free plan, which profiles.tier defaults to', () => {
    expect(planName(null)).toBe('Traveler');
    expect(planName(undefined)).toBe('Traveler');
  });

  it('names the next plan up, and none above Quartermaster', () => {
    expect(nextPlan('free')).toBe('pro');
    expect(nextPlan('pro')).toBe('dealer');
    expect(nextPlan('dealer')).toBeNull();
    expect(nextPlan(null)).toBe('pro');
  });
});
