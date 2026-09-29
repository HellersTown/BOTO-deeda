# @platform/strategy

The bidding-strategy engine for [`docs/06-bidding-strategies.md`](../../docs/06-bidding-strategies.md):
the walk-away calculator (section 4), the section 9 rules spec, and the 21 strategies (section 2).
Zero runtime dependencies. Money is integer cents. No function reads the clock; `now` is always passed in.

```sh
npm test    # node --test 'test/*.test.ts'
```

## API

```ts
import { computeMaxBid, evaluateRules, recommend } from '@platform/strategy';

computeMaxBid(context, options?)       // -> CalculatorResult: the walk-away number and its breakdown
evaluateRules(context, now, options?)  // -> RulesResult: fired rules per the spec's output_contract
recommend(context, now, options?)      // -> Recommendation: walk-away + timing + ranked strategies + explanation
portfolioExposure(entries, budget?)    // -> ExposureResult: S19, one pickup trip per site
```

`context` is a `LotContext` (see `src/types.ts`): the lot as stored plus the user's inputs.
Every field is optional. Missing data gives an explicit status (`insufficient_data`,
`needs_value`, or a rule listed under `notEvaluated`), never a guess.

- `walkAway.hammerCeilingCents` is the spec's `max_hammer_cents` (H_max, whole dollars).
  Pre-fill `watchlist.max_bid_cents` with it, per the spec's schema mapping.
- `walkAway.maxBidCents` is the number to type into the site: H_max rounded down to the
  increment ladder (default: ingest `money.ts` `defaultNextBidCents`; `options.ladder` overrides,
  `null` disables), never below the lot's next acceptable bid. `null` means don't bid.
- `timing.alertSecondsBefore` pre-fills `watchlist.remind_seconds_before`. When `timing.countdown`
  is false (`closeTimePrecise: false`, e.g. GSA's date-only close), show no countdown.
- Every result lists the parameters behind it with a status (`SE`, `SE-2nd`, `UNVERIFIED`,
  `PLACEHOLDER`, `INTERNAL`, `DESIGN`, or `LOT`/`USER`/`OVERRIDE` when replaced). `placeholders` and
  `labels.placeholders` are what the UI must badge as unverified.

## How the doc maps to the code

| Doc | Code |
|---|---|
| 4.1 formula, 4.3 defaults | `src/calculator.ts` `solveCeiling`, `computeMaxBid`; defaults read from the spec tables |
| 4.2 worked example | `test/calculator.test.ts` (the three columns, exact) |
| 5.2 increments | `EBAY_US_LADDER` (spec `ebay_us`); `DEFAULT_LADDER` mirrors money.ts (`test/ladder.test.ts`) |
| 9.2 spec (JSON) | `src/spec.ts`, copied verbatim; `test/spec-doc.test.ts` fails if it drifts from the doc |
| 9.2 `derived` | `src/rules.ts` `deriveSpecValues` (exact); `referenceDerive` runs the spec expressions literally, and `test/derived-oracle.test.ts` checks both agree on every value |
| 9.2 `rules`, `output_contract` | `RULES` is the spec array; `evaluateRules` runs each `when` through `src/jsonlogic.ts` |
| 9.3 test lots | `test/doc-table.test.ts` (all 13 primaries and ceilings) |
| 2 S1-S21 | `STRATEGIES` in `src/strategies.ts`; `recommend` ranks the applicable ones |
| 6 playbooks (alert times) | `Timing` in `recommend` |
| 11 sources ([SE], [SE-2nd]) | `EVIDENCE_STATUS` in `src/spec.ts` |

## PLACEHOLDER parameters

All are named, overridable (`options.overrides`, or the user fields shown), and reported with
their status in every result that uses them.

| Parameter | Default | Override |
|---|---|---|
| `bp_unknown_assumed_pct` (premium not captured) | 20% | `buyerPremiumPct` on the lot |
| `card_fee_unknown_assumed_rate` | 3% | `cardFeePct` on the lot |
| `pickup_time_cost_cents` | $25 | `timeValueCents` |
| `transport_share_warn` (R31) | 25% | `overrides.constants` |
| `reserve_stop_ratio` (R03) | 90% | `overrides.constants` |
| `tag_final_day_discount_rate` (R17, R18) | 50% | `overrides.constants` |
| every category value (f, s, r, u, m, Pmin, herd threshold) | section 4.3 table | `targetMarginPct`, `minProfitCents`, `repairCents`, or `overrides.categories` |

UNVERIFIED defaults: sales tax 5.5% (`salesTaxPct`), 70 cents/mile (`costPerMileCents`), and several
platform defaults. DESIGN values added here: `STRATEGY_PARAMETERS` (S7's "multi-day" = more than
1440 minutes left; S9's "$1 starts" = opening bid of 100 cents or less; a date-only close can be up
to 86400 s early), overridable through `options.strategyParameters`.

## Where the engine goes beyond the spec

Each is a value the lot or user actually has, taken over a default:

- The lot's published `nextBidCents` beats the increment ladder ("the lot page wins", `ebay_us` note).
- The lot's `cardFeePct` and `salesTaxPct` beat the defaults ("the lot's terms always win", 4.3).
- `pickupCostCents` or `shippingCents` replace the distance formula; `repairCents` replaces r x R.
  Inbound shipping is not in the doc's formula; with no figure, the gap is a warning.
- `userGoal: 'use'`: S2's personal-use rule (all-in <= the fixed-price alternative). Selling fees
  and the profit target are 0 unless the user sets a margin.
- `riskTolerance` changes wording and ordering only (S10); the doc gives no basis for changing a number.
- For a closing rule that was not captured (R19), the timing arms the extending-close alert; the spec
  gives none, and the watchlist default would fire after R19's bid time.
- Money in outputs is whole cents, rounded half away from zero. The ceiling is solved on exact values
  (the spec's formula in real numbers, not floats), so it matches the doc's arithmetic to the dollar.
