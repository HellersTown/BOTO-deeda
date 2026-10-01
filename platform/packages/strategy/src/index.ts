/**
 * @platform/strategy: what to tell a user about one lot.
 *
 *   computeMaxBid(context)          the walk-away number (docs/06 section 4)
 *   projectAtHammer(context, h)     profit (or saving) if won at hammer h, on the same terms
 *   evaluateRules(context, now)     the section 9 rules spec, evaluated
 *   recommend(context, now)         number + moment + ranked strategies + reasons
 *
 * Zero runtime dependencies, integer cents, and no clock reads: `now` is always
 * passed in.
 */

export { DEFAULT_LADDER, EBAY_US_LADDER, computeMaxBid, highestValidBid, incrementFor, projectAtHammer } from './calculator.ts';
export {
  EVIDENCE_STATUS,
  IMPRECISE_CLOSE_CAVEAT,
  RULES,
  SPEC,
  evaluateRules,
  referenceDerive,
  renderTemplate,
  ruleEvidenceLabel,
} from './rules.ts';
export { STRATEGIES, STRATEGY_PARAMETERS, portfolioExposure, recommend, strategyById } from './strategies.ts';
export type { ExposureEntry, ExposureResult, RecommendOptions, StrategyParameters } from './strategies.ts';
export { GOVERNMENT_PLATFORMS, GOVERNMENT_TIERS } from './resolve.ts';
export { formatPercent, formatUsd } from './exact.ts';
export type * from './types.ts';
