/**
 * The section 9.2 rules spec from docs/06-bidding-strategies.md, verbatim.
 *
 * This is data, copied character for character from the doc so that the doc stays
 * the one place where rules, thresholds and their evidence are argued about.
 * test/spec-doc.test.ts parses the JSON block out of the doc and fails if this
 * object differs from it in any value. When the doc changes, re-copy the block;
 * never edit a value here by hand.
 *
 * Nothing mutates it. Parameters are replaced per call through
 * EngineOptions.overrides, which keeps the labels honest: a replaced value is
 * reported as OVERRIDE, and an untouched one keeps the doc's label.
 */

import type { EvidenceLabel, RulesSpec } from './types.ts';

export const SPEC: RulesSpec = {
  "spec": "paddleup.bidding-rules",
  "version": "1.0.0",
  "as_of": "2026-09-27",
  "status_legend": {
    "SE": "Stated in a search-engine extract of the cited page; the page itself could not be fetched from the research environment.",
    "SE-2nd": "Stated in a search-engine extract of a secondary or third-party page; confirm against the primary source.",
    "INTERNAL": "Aligned with PaddleUp's own compute_sleeper() thresholds (migration 0006); not an external finding.",
    "DESIGN": "A product design choice, not a claim about the world.",
    "PLACEHOLDER": "Not a measured value. Must be replaced by a sourced or calibrated value before it is shown to users as advice.",
    "UNVERIFIED": "Not confirmed by any source in this research pass."
  },
  "expression_language": {
    "name": "JSONLogic subset (https://jsonlogic.com)",
    "standard_ops": ["var", "if", "==", "!=", "<", "<=", ">", ">=", "and", "or", "!", "in", "+", "-", "*", "/", "min", "max"],
    "notes": [
      "'-' is binary, as in json-logic-js. '+' and '*' are variadic.",
      "Never pass null into min/max or arithmetic: every expression below guards with != null first, because json-logic-js coerces null to 0 in comparisons and NaN in arithmetic.",
      "'if' takes [cond1, value1, cond2, value2, ..., else].",
      "Data object seen by 'var': the lot inputs, every derived value computed so far, and 'constants' (so {\"var\": \"constants.sales_tax_rate\"} works)."
    ],
    "custom_ops": {
      "floor": "[x] -> Math.floor(x); null if x is null.",
      "minutes_until": "[iso_timestamp] -> (timestamp - context.now) in minutes, as a float. Negative once closed. null if the timestamp is null.",
      "platform_attr": "[attr] -> platforms[platform][attr]; if the full platform key is absent, platforms[base][attr] where base is the text before ':'; if that is absent too, platforms['other'][attr].",
      "category_attr": "[attr] -> categories[category][attr], falling back to categories['other'][attr].",
      "increment_ladder": "[amount_cents, ladder_name] -> the increment of the highest rung whose from_cents <= amount_cents in increment_ladders[ladder_name]."
    }
  },
  "inputs": {
    "current_bid_cents": {
      "type": "integer",
      "required": true,
      "doc": "Current high bid. For a fixed-price tag sale, the tag price. For a lot with no bids, the opening/minimum bid."
    },
    "bid_count": {"type": "integer", "required": true},
    "closes_at": {"type": "string", "format": "date-time", "required": true, "doc": "Scheduled close (tag sales: the end of the sale)."},
    "soft_close_window_minutes": {
      "type": ["integer", "null"],
      "required": false,
      "doc": "Extension window as published for this auction. 0 = hard close. null = not captured; the platform default applies."
    },
    "platform": {
      "type": "string",
      "required": true,
      "doc": "sources.platform value, optionally suffixed with a format: '<platform>[:timed|webcast|sealed|tag]'. Keys are listed under 'platforms'."
    },
    "buyer_premium_pct": {"type": ["number", "null"], "required": false, "doc": "Percent, e.g. 15 for 15%. null = not captured."},
    "reserve_flag": {"type": "string", "enum": ["absolute", "reserve_met", "reserve_not_met", "unknown"], "required": true},
    "pickup_distance_miles": {"type": ["number", "null"], "required": false, "doc": "One-way road miles from the user to the pickup site. null = ships or unknown."},
    "image_count": {"type": "integer", "required": true},
    "description_word_count": {"type": "integer", "required": true, "doc": "Word count of title + description, the same quantity as lots.desc_richness."},
    "category": {"type": "string", "required": true, "doc": "Keys are listed under 'categories'."},
    "expected_resale_cents": {
      "type": ["integer", "null"],
      "required": false,
      "user_input": true,
      "doc": "Median of recent SOLD comps in the same condition (a personal-use buyer enters the best fixed-price alternative instead)."
    },
    "user_max_budget_cents": {
      "type": ["integer", "null"],
      "required": false,
      "user_input": true,
      "doc": "The most the user will pay the auction for this lot, invoice total (hammer + premium + tax + card fee)."
    }
  },
  "context": {
    "now": "Evaluation timestamp supplied by the evaluator. It is the only value not taken from the lot or the user, and is needed to turn closes_at into time remaining."
  },
  "constants": {
    "sales_tax_rate": 0.055,
    "bp_unknown_assumed_pct": 20,
    "card_fee_unknown_assumed_rate": 0.03,
    "mileage_cost_cents_per_mile": 70,
    "pickup_time_cost_cents": 2500,
    "transport_share_warn": 0.25,
    "reserve_stop_ratio": 0.9,
    "thin_listing_max_words": 12,
    "full_confidence_min_photos": 3,
    "quiet_max_bids": 1,
    "closing_quiet_minutes": 720,
    "hard_close_alert_seconds": 120,
    "manual_snipe_seconds": 10,
    "soft_close_alert_buffer_minutes": 5,
    "unknown_window_assumed_minutes": 10,
    "live_absentee_alert_seconds": 3600,
    "sealed_alert_seconds": 86400,
    "tag_final_day_discount_rate": 0.5,
    "winners_curse_note_min_haircut": 0.15
  },
  "constants_meta": {
    "sales_tax_rate": {
      "status": "UNVERIFIED",
      "note": "Wisconsin 5% state + 0.5% county, the common combination. Milwaukee County and City rates differ; premier-resort-area taxes exist; whether the buyer's premium is taxable was not verified. A reseller with a valid exemption certificate sets this to 0 for resale inventory."
    },
    "bp_unknown_assumed_pct": {
      "status": "PLACEHOLDER",
      "note": "Deliberately conservative assumption used only when the premium was not captured. The lot's own terms always win."
    },
    "card_fee_unknown_assumed_rate": {"status": "PLACEHOLDER", "note": "Assumes card payment. A third-party guide reports GovDeals card surcharges of 2.5-3.5% (SE-2nd)."},
    "mileage_cost_cents_per_mile": {
      "status": "UNVERIFIED",
      "note": "IRS 2025 business standard mileage rate (70 cents/mile), from memory; replace with the current year's rate or the user's own cost."
    },
    "pickup_time_cost_cents": {"status": "PLACEHOLDER", "note": "One hour at $25/hour for the pickup trip. User-editable."},
    "transport_share_warn": {"status": "PLACEHOLDER"},
    "reserve_stop_ratio": {"status": "PLACEHOLDER"},
    "thin_listing_max_words": {"status": "INTERNAL", "note": "compute_sleeper(): fewer than 12 words = thin_description."},
    "full_confidence_min_photos": {"status": "INTERNAL", "note": "compute_sleeper(): 3+ photos = full confidence."},
    "quiet_max_bids": {"status": "INTERNAL", "note": "compute_sleeper(): 0-1 bids = low_competition."},
    "closing_quiet_minutes": {"status": "INTERNAL", "note": "compute_sleeper(): closes within 12 hours and still quiet."},
    "hard_close_alert_seconds": {"status": "DESIGN", "note": "Maps to watchlist.remind_seconds_before."},
    "manual_snipe_seconds": {
      "status": "DESIGN",
      "note": "Ely & Hossain placed snipes in the last 5 seconds with a sniping service (SE-2nd); Roth & Ockenfels note very late bids may fail to go through, so a human doing it by hand needs margin."
    },
    "soft_close_alert_buffer_minutes": {"status": "DESIGN"},
    "unknown_window_assumed_minutes": {
      "status": "DESIGN",
      "note": "The longest window observed in this research (Wisconsin Surplus, 10 minutes), so 'bid before the window' is safe for any shorter one."
    },
    "live_absentee_alert_seconds": {"status": "DESIGN"},
    "sealed_alert_seconds": {"status": "DESIGN"},
    "tag_final_day_discount_rate": {
      "status": "PLACEHOLDER",
      "note": "Estate-sale discount schedules vary by company; 50% off on the last day is the example in the product brief and is NOT verified."
    },
    "winners_curse_note_min_haircut": {"status": "DESIGN"}
  },
  "increment_ladders": {
    "ebay_us": {
      "status": "SE-2nd",
      "source": "ebay_automatic_bidding (table assembled in a search summary of eBay help/community pages and a LiveAbout explainer; verify against eBay help)",
      "note": "Used as a proxy ladder for platforms whose increments were not verified. Auctioneers and GSA set their own increments; the lot page wins.",
      "rungs": [
        {"from_cents": 0, "increment_cents": 5},
        {"from_cents": 100, "increment_cents": 25},
        {"from_cents": 500, "increment_cents": 50},
        {"from_cents": 2500, "increment_cents": 100},
        {"from_cents": 10000, "increment_cents": 250},
        {"from_cents": 25000, "increment_cents": 500},
        {"from_cents": 50000, "increment_cents": 1000},
        {"from_cents": 100000, "increment_cents": 2500},
        {"from_cents": 250000, "increment_cents": 5000},
        {"from_cents": 500000, "increment_cents": 10000}
      ]
    }
  },
  "platforms": {
    "ebay": {
      "base": "ebay",
      "close_type": "hard",
      "soft_close_default_minutes": 0,
      "bp_default_pct": 0,
      "card_fee_default_rate": 0,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE roth_ockenfels_2002 (fixed end time)", "bp_default_pct": "UNVERIFIED (no buyer's premium on eBay auctions; not re-checked)", "card_fee_default_rate": "UNVERIFIED"}
    },
    "gsa": {
      "base": "gsa",
      "close_type": "inactivity",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": 0,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE gsa_faq: closes after a per-lot inactivity period (FAQ example uses 10 minutes); the period is on the 'Bidding Details' tab", "bp_default_pct": "SE-2nd gsa_thirdparty (BidProwl: no buyer's premium)", "card_fee_default_rate": "UNVERIFIED (cards accepted up to $24,999.99 per card per day, SE gsa_faq; no surcharge found)", "deposit": "05-market-research.md reports a refundable deposit before bidding on most vehicles [3P there]"}
    },
    "gsa:sealed": {
      "base": "gsa",
      "close_type": "sealed",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": 0,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED (sealed-bid mechanics not researched in this pass)", "bp_default_pct": "SE-2nd gsa_thirdparty"}
    },
    "govdeals": {
      "base": "govdeals",
      "close_type": "soft",
      "soft_close_default_minutes": 3,
      "bp_default_pct": 12.5,
      "card_fee_default_rate": 0.03,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE-2nd govdeals_thirdparty says 3 minutes; another guide cited in 05-market-research.md says '2-5 minutes' [3P]. Primary rule not captured", "bp_default_pct": "SE-2nd govdeals_thirdparty (reported cap 12.5%, typical 7.5-12.5%, set by seller)", "card_fee_default_rate": "SE-2nd govdeals_thirdparty (2.5-3.5% card surcharge; midpoint used)"}
    },
    "public-surplus": {
      "base": "public-surplus",
      "close_type": "soft",
      "soft_close_default_minutes": 5,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE public_surplus_extensions", "bp_default_pct": "UNVERIFIED (set per selling agency)"}
    },
    "public-surplus:sealed": {
      "base": "public-surplus",
      "close_type": "sealed",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED"}
    },
    "municibid": {
      "base": "municibid",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE-2nd (third-party guide lists Municibid among soft-close sites; window UNVERIFIED)", "bp_default_pct": "05-market-research.md reports a tiered 9/6/4% fee [3P there]; tiers depend on amount, so left null"}
    },
    "wisconsin-surplus": {
      "base": "wisconsin-surplus",
      "close_type": "soft",
      "soft_close_default_minutes": 10,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE wisconsin_surplus_terms (AutoExtend, 10 minutes)", "bp_default_pct": "SE wisconsin_surplus_terms: tiered buyer's fee by bid size; 05-market-research.md reports '0-10%, set per seller (median ~7%)' [3P there]; left null until the tiers are captured"}
    },
    "hibid": {
      "base": "hibid",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE hibid_softclose_examples: set per auctioneer; 2, 3 and 'normally 3-5' minutes observed", "bp_default_pct": "Per auctioneer. 05-market-research.md reports 'typically 10-18%', sometimes a few percent more for online bidding [3P there]; left null so the conservative assumption applies until captured"}
    },
    "hibid:webcast": {
      "base": "hibid",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "k-bid": {
      "base": "k-bid",
      "close_type": "soft",
      "soft_close_default_minutes": 3,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE kbid_softclose (one K-BID auction's own FAQ lot; may vary by seller)"}
    },
    "proxibid": {
      "base": "proxibid",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "SE proxibid_timed ('Most Timed auctions will have a period during which bidding is extended'); window set per seller; group ('one extend all extend') extensions reported by buyers (SE yesterdays_tractors_forum)"}
    },
    "proxibid:webcast": {
      "base": "proxibid",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "bidspotter": {
      "base": "bidspotter",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED"}
    },
    "bidspotter:webcast": {
      "base": "bidspotter",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "purple-wave": {
      "base": "purple-wave",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "UNVERIFIED (extension rule and buyer's premium not captured in this pass)"}
    },
    "auctionzip": {
      "base": "auctionzip",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "AuctionZip is a directory; the listed house's own software decides the format"}
    },
    "auctionzip:webcast": {
      "base": "auctionzip",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "maxsold": {
      "base": "maxsold",
      "close_type": "soft",
      "soft_close_default_minutes": 2,
      "bp_default_pct": 18,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE maxsold_softclose", "bp_default_pct": "INTERNAL cross-reference: 05-market-research.md reports an 18% premium that is itself taxed [1P there]"}
    },
    "auctionninja": {
      "base": "auctionninja",
      "close_type": "soft",
      "soft_close_default_minutes": 5,
      "bp_default_pct": 18,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"soft_close_default_minutes": "SE auctionninja_extended", "bp_default_pct": "INTERNAL cross-reference: 05-market-research.md reports '18% is the site average', most sellers 10-20%, seller-set [1P there]"}
    },
    "estatesales-net": {
      "base": "estatesales-net",
      "close_type": "fixed",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {"close_type": "Tag sale: fixed prices, first come first served (01-sources.md, Tier 5)", "bp_default_pct": "UNVERIFIED (tag sales normally carry no premium; card fees vary by company)"}
    },
    "other": {
      "base": "other",
      "close_type": "unknown",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:hard": {
      "base": "other",
      "close_type": "hard",
      "soft_close_default_minutes": 0,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:timed": {
      "base": "other",
      "close_type": "soft",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:webcast": {
      "base": "other",
      "close_type": "live",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:sealed": {
      "base": "other",
      "close_type": "sealed",
      "soft_close_default_minutes": null,
      "bp_default_pct": null,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    },
    "other:tag": {
      "base": "other",
      "close_type": "fixed",
      "soft_close_default_minutes": null,
      "bp_default_pct": 0,
      "card_fee_default_rate": null,
      "increment_ladder": "ebay_us",
      "_meta": {}
    }
  },
  "categories": {
    "tools": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.1, "target_margin_rate": 0.3, "min_profit_cents": 2500, "herd_bid_count": 15, "high_value_risk": false},
    "electronics": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.2, "target_margin_rate": 0.3, "min_profit_cents": 2500, "herd_bid_count": 15, "high_value_risk": true},
    "vehicles": {"sell_fee_rate": 0.0, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.2, "min_profit_cents": 50000, "herd_bid_count": 20, "high_value_risk": true},
    "farm_equipment": {"sell_fee_rate": 0.1, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.2, "min_profit_cents": 50000, "herd_bid_count": 20, "high_value_risk": true},
    "construction_equipment": {"sell_fee_rate": 0.1, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.2, "min_profit_cents": 50000, "herd_bid_count": 20, "high_value_risk": true},
    "furniture": {"sell_fee_rate": 0.0, "outbound_ship_cents": 0, "repair_reserve_rate": 0.1, "uncertainty_haircut_rate": 0.1, "target_margin_rate": 0.4, "min_profit_cents": 5000, "herd_bid_count": 10, "high_value_risk": false},
    "coins_bullion": {"sell_fee_rate": 0.05, "outbound_ship_cents": 0, "repair_reserve_rate": 0.0, "uncertainty_haircut_rate": 0.05, "target_margin_rate": 0.1, "min_profit_cents": 1000, "herd_bid_count": 20, "high_value_risk": true},
    "jewelry": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.25, "target_margin_rate": 0.3, "min_profit_cents": 5000, "herd_bid_count": 15, "high_value_risk": true},
    "collectibles": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.0, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.3, "min_profit_cents": 2000, "herd_bid_count": 15, "high_value_risk": false},
    "household_general": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.4, "min_profit_cents": 1500, "herd_bid_count": 10, "high_value_risk": false},
    "aircraft": {"sell_fee_rate": 0.1, "outbound_ship_cents": 0, "repair_reserve_rate": 0.2, "uncertainty_haircut_rate": 0.3, "target_margin_rate": 0.25, "min_profit_cents": 500000, "herd_bid_count": 10, "high_value_risk": true},
    "other": {"sell_fee_rate": 0.14, "outbound_ship_cents": 0, "repair_reserve_rate": 0.05, "uncertainty_haircut_rate": 0.15, "target_margin_rate": 0.3, "min_profit_cents": 2000, "herd_bid_count": 15, "high_value_risk": false}
  },
  "categories_meta": {
    "status": "PLACEHOLDER",
    "note": "EVERY VALUE IN THIS TABLE IS A PLACEHOLDER. None was measured or sourced in this research pass. Replace with values calibrated from PaddleUp's own outcomes (watchlist.outcome, lots.sold_price_cents) and a sourced selling-fee schedule before showing them as advice."
  },
  "derived": [
    {"name": "close_type", "expr": {"platform_attr": ["close_type"]}},
    {"name": "platform_base", "expr": {"platform_attr": ["base"]}},
    {
      "name": "window_min",
      "expr": {"if": [{"!=": [{"var": "soft_close_window_minutes"}, null]}, {"var": "soft_close_window_minutes"}, {"platform_attr": ["soft_close_default_minutes"]}]},
      "doc": "The lot's own extension window, else the platform default, else null."
    },
    {
      "name": "is_hard_close",
      "expr": {"or": [{"==": [{"var": "close_type"}, "hard"]}, {"and": [{"in": [{"var": "close_type"}, ["soft", "inactivity", "unknown"]]}, {"!=": [{"var": "window_min"}, null]}, {"==": [{"var": "window_min"}, 0]}]}]}
    },
    {
      "name": "effective_close_type",
      "expr": {"if": [{"in": [{"var": "close_type"}, ["live", "sealed", "fixed"]]}, {"var": "close_type"}, {"var": "is_hard_close"}, "hard", {"in": [{"var": "close_type"}, ["soft", "inactivity"]]}, {"var": "close_type"}, {"and": [{"!=": [{"var": "window_min"}, null]}, {">": [{"var": "window_min"}, 0]}]}, "soft", "unknown"]},
      "doc": "hard | soft | inactivity | live | sealed | fixed | unknown. A lot that publishes a window > 0 is treated as extending even if the platform default is unknown."
    },
    {"name": "is_extending_close", "expr": {"in": [{"var": "effective_close_type"}, ["soft", "inactivity"]]}},
    {"name": "bp_assumed", "expr": {"==": [{"var": "buyer_premium_pct"}, null]}},
    {
      "name": "bp_pct",
      "expr": {"if": [{"!=": [{"var": "buyer_premium_pct"}, null]}, {"var": "buyer_premium_pct"}, {"!=": [{"platform_attr": ["bp_default_pct"]}, null]}, {"platform_attr": ["bp_default_pct"]}, {"var": "constants.bp_unknown_assumed_pct"}]}
    },
    {
      "name": "bp_source",
      "expr": {"if": [{"!=": [{"var": "buyer_premium_pct"}, null]}, "the lot's terms", {"!=": [{"platform_attr": ["bp_default_pct"]}, null]}, "platform default", "conservative assumption"]}
    },
    {
      "name": "card_fee_rate",
      "expr": {"if": [{"!=": [{"platform_attr": ["card_fee_default_rate"]}, null]}, {"platform_attr": ["card_fee_default_rate"]}, {"var": "constants.card_fee_unknown_assumed_rate"}]}
    },
    {"name": "tax_rate", "expr": {"var": "constants.sales_tax_rate"}},
    {
      "name": "cost_multiplier",
      "expr": {"*": [{"+": [1, {"/": [{"var": "bp_pct"}, 100]}]}, {"+": [1, {"var": "tax_rate"}]}, {"+": [1, {"var": "card_fee_rate"}]}]},
      "doc": "k: what one dollar of hammer price costs on the invoice."
    },
    {"name": "transport_known", "expr": {"!=": [{"var": "pickup_distance_miles"}, null]}},
    {
      "name": "transport_cents",
      "expr": {"if": [{"var": "transport_known"}, {"+": [{"*": [{"var": "pickup_distance_miles"}, 2, {"var": "constants.mileage_cost_cents_per_mile"}]}, {"var": "constants.pickup_time_cost_cents"}]}, 0]},
      "doc": "Round trip at the mileage rate plus the time cost. 0 when the lot ships or distance is unknown (inbound shipping is then NOT modelled)."
    },
    {"name": "has_value", "expr": {"and": [{"!=": [{"var": "expected_resale_cents"}, null]}, {">": [{"var": "expected_resale_cents"}, 0]}]}},
    {"name": "has_budget", "expr": {"and": [{"!=": [{"var": "user_max_budget_cents"}, null]}, {">": [{"var": "user_max_budget_cents"}, 0]}]}},
    {"name": "sell_fee_rate", "expr": {"category_attr": ["sell_fee_rate"]}},
    {"name": "outbound_ship_cents", "expr": {"category_attr": ["outbound_ship_cents"]}},
    {"name": "uncertainty_haircut_rate", "expr": {"category_attr": ["uncertainty_haircut_rate"]}},
    {"name": "repair_reserve_rate", "expr": {"category_attr": ["repair_reserve_rate"]}},
    {"name": "target_margin_rate", "expr": {"category_attr": ["target_margin_rate"]}},
    {"name": "min_profit_cents", "expr": {"category_attr": ["min_profit_cents"]}},
    {
      "name": "net_proceeds_cents",
      "expr": {"if": [{"var": "has_value"}, {"-": [{"*": [{"var": "expected_resale_cents"}, {"-": [1, {"var": "sell_fee_rate"}]}]}, {"var": "outbound_ship_cents"}]}, null]}
    },
    {
      "name": "profit_target_cents",
      "expr": {"if": [{"var": "has_value"}, {"max": [{"*": [{"var": "expected_resale_cents"}, {"var": "target_margin_rate"}]}, {"var": "min_profit_cents"}]}, null]}
    },
    {
      "name": "risk_reserve_cents",
      "expr": {"if": [{"var": "has_value"}, {"*": [{"var": "expected_resale_cents"}, {"+": [{"var": "uncertainty_haircut_rate"}, {"var": "repair_reserve_rate"}]}]}, null]}
    },
    {
      "name": "max_hammer_resale_cents",
      "expr": {"if": [{"var": "has_value"}, {"max": [0, {"*": [100, {"floor": [{"/": [{"/": [{"-": [{"var": "net_proceeds_cents"}, {"+": [{"var": "profit_target_cents"}, {"var": "transport_cents"}, {"var": "risk_reserve_cents"}]}]}, {"var": "cost_multiplier"}]}, 100]}]}]}]}, null]},
      "doc": "H_resale = floor_to_dollar( (N - P - T - risk) / k ), never below 0."
    },
    {
      "name": "max_hammer_budget_cents",
      "expr": {"if": [{"var": "has_budget"}, {"*": [100, {"floor": [{"/": [{"/": [{"var": "user_max_budget_cents"}, {"var": "cost_multiplier"}]}, 100]}]}]}, null]}
    },
    {
      "name": "max_hammer_cents",
      "expr": {"if": [{"and": [{"var": "has_value"}, {"var": "has_budget"}]}, {"min": [{"var": "max_hammer_resale_cents"}, {"var": "max_hammer_budget_cents"}]}, {"var": "has_value"}, {"var": "max_hammer_resale_cents"}, {"var": "has_budget"}, {"var": "max_hammer_budget_cents"}, null]}
    },
    {
      "name": "binding_cap",
      "expr": {"if": [{"and": [{"var": "has_value"}, {"var": "has_budget"}]}, {"if": [{"<=": [{"var": "max_hammer_budget_cents"}, {"var": "max_hammer_resale_cents"}]}, "budget", "resale value"]}, {"var": "has_value"}, "resale value", {"var": "has_budget"}, "budget", "none"]}
    },
    {"name": "increment_cents", "expr": {"increment_ladder": [{"var": "current_bid_cents"}, {"platform_attr": ["increment_ladder"]}]}},
    {
      "name": "next_min_bid_cents",
      "expr": {"if": [{"or": [{"==": [{"var": "bid_count"}, 0]}, {"==": [{"var": "effective_close_type"}, "fixed"]}]}, {"var": "current_bid_cents"}, {"+": [{"var": "current_bid_cents"}, {"var": "increment_cents"}]}]},
      "doc": "With no bids the opening bid is the minimum; otherwise current + one increment (proxy ladder)."
    },
    {"name": "minutes_to_close", "expr": {"minutes_until": [{"var": "closes_at"}]}},
    {"name": "is_open", "expr": {">": [{"var": "minutes_to_close"}, 0]}},
    {
      "name": "all_in_at_current_cents",
      "expr": {"+": [{"*": [{"var": "current_bid_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}]}
    },
    {"name": "all_in_at_next_cents", "expr": {"+": [{"*": [{"var": "next_min_bid_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}]}},
    {
      "name": "all_in_at_max_cents",
      "expr": {"if": [{"!=": [{"var": "max_hammer_cents"}, null]}, {"+": [{"*": [{"var": "max_hammer_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}]}, null]}
    },
    {
      "name": "headroom_cents",
      "expr": {"if": [{"!=": [{"var": "max_hammer_cents"}, null]}, {"-": [{"var": "max_hammer_cents"}, {"var": "next_min_bid_cents"}]}, null]}
    },
    {
      "name": "current_to_max_ratio",
      "expr": {"if": [{"and": [{"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}]}, {"/": [{"var": "current_bid_cents"}, {"var": "max_hammer_cents"}]}, null]}
    },
    {
      "name": "profit_at_next_cents",
      "expr": {"if": [{"var": "has_value"}, {"-": [{"var": "net_proceeds_cents"}, {"+": [{"*": [{"var": "next_min_bid_cents"}, {"var": "cost_multiplier"}]}, {"var": "transport_cents"}, {"var": "risk_reserve_cents"}]}]}, null]}
    },
    {
      "name": "thirds_rule_cents",
      "expr": {"if": [{"var": "has_value"}, {"floor": [{"/": [{"var": "expected_resale_cents"}, 3]}]}, null]},
      "doc": "Practitioner 'rule of thirds' cross-check (UNVERIFIED heuristic). Display only; never used as the ceiling."
    },
    {"name": "transport_share", "expr": {"if": [{"var": "has_value"}, {"/": [{"var": "transport_cents"}, {"var": "expected_resale_cents"}]}, null]}},
    {"name": "cost_per_100_cents", "expr": {"floor": [{"*": [10000, {"var": "cost_multiplier"}]}]}},
    {"name": "is_thin_listing", "expr": {"<": [{"var": "description_word_count"}, {"var": "constants.thin_listing_max_words"}]}},
    {"name": "is_few_photos", "expr": {"<": [{"var": "image_count"}, {"var": "constants.full_confidence_min_photos"}]}},
    {"name": "is_quiet", "expr": {"<=": [{"var": "bid_count"}, {"var": "constants.quiet_max_bids"}]}},
    {"name": "herd_bid_count", "expr": {"category_attr": ["herd_bid_count"]}},
    {"name": "is_crowded", "expr": {">=": [{"var": "bid_count"}, {"var": "herd_bid_count"}]}},
    {"name": "high_value_risk", "expr": {"category_attr": ["high_value_risk"]}},
    {
      "name": "effective_window_min",
      "expr": {"if": [{"!=": [{"var": "window_min"}, null]}, {"var": "window_min"}, {"var": "constants.unknown_window_assumed_minutes"}]}
    },
    {"name": "proxy_deadline_minutes_before_close", "expr": {"+": [{"var": "effective_window_min"}, 1]}},
    {
      "name": "alert_seconds_before",
      "expr": {"if": [{"var": "is_hard_close"}, {"var": "constants.hard_close_alert_seconds"}, {"var": "is_extending_close"}, {"*": [{"+": [{"var": "effective_window_min"}, {"var": "constants.soft_close_alert_buffer_minutes"}]}, 60]}, {"==": [{"var": "effective_close_type"}, "live"]}, {"var": "constants.live_absentee_alert_seconds"}, {"==": [{"var": "effective_close_type"}, "sealed"]}, {"var": "constants.sealed_alert_seconds"}, null]},
      "doc": "Suggested value for watchlist.remind_seconds_before."
    },
    {
      "name": "tag_price_final_day_cents",
      "expr": {"floor": [{"*": [{"var": "current_bid_cents"}, {"-": [1, {"var": "constants.tag_final_day_discount_rate"}]}]}]}
    }
  ],
  "rules": [
    {
      "id": "R00",
      "code": "LOT_CLOSED",
      "kind": "action",
      "priority": 1,
      "confidence": "high",
      "evidence": [],
      "when": {"!": [{"var": "is_open"}]},
      "text": "This lot has closed. Record the result (won, lost, price) so PaddleUp can calibrate your ceilings.",
      "numbers": ["current_bid_cents", "bid_count", "max_hammer_cents"]
    },
    {
      "id": "R01",
      "code": "WALK_AWAY_UNECONOMIC",
      "kind": "action",
      "priority": 5,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "bazerman_samuelson_1983"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"var": "has_value"}, {"==": [{"var": "max_hammer_resale_cents"}, 0]}]}]},
      "text": "Skip this lot. Even at a $0 hammer it does not clear your margin: expected resale {expected_resale_cents|usd}, net after selling costs {net_proceeds_cents|usd}, minus required profit {profit_target_cents|usd}, pickup {transport_cents|usd} and risk reserve {risk_reserve_cents|usd}.",
      "numbers": ["expected_resale_cents", "net_proceeds_cents", "profit_target_cents", "transport_cents", "risk_reserve_cents"]
    },
    {
      "id": "R02",
      "code": "WALK_AWAY_OVER_MAX",
      "kind": "action",
      "priority": 10,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "bazerman_samuelson_1983", "ku_malhotra_murnighan_2005"],
      "when": {"and": [{"var": "is_open"}, {"!=": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {">": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Walk away. The next bid would be {next_min_bid_cents|usd}; your ceiling is {max_hammer_cents|usd} (set by your {binding_cap}). At the next bid you would pay about {all_in_at_next_cents|usd} all-in. Do not raise a ceiling because other people are bidding; raise it only for new information about the item.",
      "numbers": ["next_min_bid_cents", "max_hammer_cents", "binding_cap", "all_in_at_next_cents", "cost_multiplier"]
    },
    {
      "id": "R03",
      "code": "RESERVE_NOT_MET_STOP",
      "kind": "action",
      "priority": 15,
      "confidence": "medium",
      "evidence": ["katkar_reiley_2006", "bajari_hortacsu_2003"],
      "when": {"and": [{"var": "is_open"}, {"!=": [{"var": "effective_close_type"}, "fixed"]}, {"==": [{"var": "reserve_flag"}, "reserve_not_met"]}, {"!=": [{"var": "current_to_max_ratio"}, null]}, {">=": [{"var": "current_to_max_ratio"}, {"var": "constants.reserve_stop_ratio"}]}]},
      "text": "Reserve not met, and bidding is already at {current_to_max_ratio|pct} of your ceiling ({max_hammer_cents|usd}). The hidden reserve is probably above what this lot is worth to you. Do not chase it; watch for a relist.",
      "numbers": ["current_bid_cents", "max_hammer_cents", "current_to_max_ratio"]
    },
    {
      "id": "R10",
      "code": "HARD_CLOSE_SINGLE_LATE_BID",
      "kind": "action",
      "priority": 30,
      "confidence": "medium",
      "evidence": ["roth_ockenfels_2002", "ockenfels_roth_2006", "ely_hossain_2009", "gray_reiley_2013", "engelberg_williams_2009", "heyman_orhun_ariely_2004"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_hard_close"}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Hard close: the clock will not extend. Don't bid yet. PaddleUp will alert you {alert_seconds_before} seconds before the end; then place ONE bid of {max_hammer_cents|usd} with about {constants.manual_snipe_seconds} seconds left. Bidding early mainly helps incremental bidders and shill bidders find your number.",
      "numbers": ["max_hammer_cents", "minutes_to_close", "alert_seconds_before", "headroom_cents", "all_in_at_max_cents"]
    },
    {
      "id": "R11",
      "code": "PROXY_BEFORE_WINDOW",
      "kind": "action",
      "priority": 31,
      "confidence": "high",
      "evidence": ["ockenfels_roth_2006", "ariely_ockenfels_roth_2005", "overstock_softclose_2019", "public_surplus_extensions", "wisconsin_surplus_terms", "gsa_faq"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}, {">": [{"var": "minutes_to_close"}, {"var": "effective_window_min"}]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Extending close: a bid in the last {effective_window_min} minutes pushes the close back, so a last-second bid gains nothing. Enter your full ceiling of {max_hammer_cents|usd} as a max (proxy) bid once, at least {proxy_deadline_minutes_before_close} minutes before the scheduled close, then leave it alone.",
      "numbers": ["max_hammer_cents", "window_min", "effective_window_min", "minutes_to_close", "proxy_deadline_minutes_before_close", "alert_seconds_before"]
    },
    {
      "id": "R12",
      "code": "IN_EXTENSION_WINDOW",
      "kind": "action",
      "priority": 32,
      "confidence": "high",
      "evidence": ["ockenfels_roth_2006", "ku_malhotra_murnighan_2005", "heyman_orhun_ariely_2004"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}, {"<=": [{"var": "minutes_to_close"}, {"var": "effective_window_min"}]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "You are inside the {effective_window_min}-minute extension window, so any bid restarts the clock. If your ceiling is not already in, enter {max_hammer_cents|usd} once. Do not raise it just because the clock is running; time pressure and rivalry are the conditions under which bidders overpay.",
      "numbers": ["max_hammer_cents", "window_min", "effective_window_min", "minutes_to_close", "headroom_cents"]
    },
    {
      "id": "R13",
      "code": "EXTENSION_RULE_UNKNOWN",
      "kind": "warning",
      "priority": 33,
      "confidence": "medium",
      "evidence": ["hibid_softclose_examples", "proxibid_timed"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}, {"==": [{"var": "window_min"}, null]}]},
      "text": "This lot extends on late bids, but its extension window was not captured. Read the auction terms. Until then PaddleUp assumes up to {constants.unknown_window_assumed_minutes} minutes.",
      "numbers": ["effective_window_min", "minutes_to_close"]
    },
    {
      "id": "R14",
      "code": "WEBCAST_ABSENTEE_BID",
      "kind": "action",
      "priority": 34,
      "confidence": "medium",
      "evidence": ["ku_malhotra_murnighan_2005", "heyman_orhun_ariely_2004"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "live"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Live webcast: leave an absentee (max) bid of {max_hammer_cents|usd} before the sale instead of bidding live. If you do bid live, write the ceiling down before the lot opens; rivalry, an audience and a fast clock are the conditions under which bidders overbid.",
      "numbers": ["max_hammer_cents", "minutes_to_close", "alert_seconds_before"]
    },
    {
      "id": "R15",
      "code": "SEALED_BID_AT_CEILING",
      "kind": "action",
      "priority": 35,
      "confidence": "medium",
      "evidence": ["bazerman_samuelson_1983", "bajari_hortacsu_2003"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "sealed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}]},
      "text": "Sealed bid: you pay what you bid. Submit {max_hammer_cents|usd} or less; your margin and risk reserve are already inside that number, and anything above it hands them to the seller.",
      "numbers": ["max_hammer_cents", "all_in_at_max_cents", "risk_reserve_cents"]
    },
    {
      "id": "R16",
      "code": "TAG_BUY_EARLY",
      "kind": "action",
      "priority": 36,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {"<=": [{"var": "current_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "The tag price {current_bid_cents|usd} is already under your ceiling {max_hammer_cents|usd}. Go on the first day, early; waiting for a discount risks losing it to another buyer.",
      "numbers": ["current_bid_cents", "max_hammer_cents", "all_in_at_current_cents"]
    },
    {
      "id": "R17",
      "code": "TAG_WAIT_FOR_DISCOUNT",
      "kind": "action",
      "priority": 37,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "current_bid_cents"}, {"var": "max_hammer_cents"}]}, {"<=": [{"var": "tag_price_final_day_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Over your ceiling at full tag ({current_bid_cents|usd}). If this company discounts on its last day (check its schedule; the discount assumed here is not verified), the price would be about {tag_price_final_day_cents|usd}, under your ceiling of {max_hammer_cents|usd}. Go on the last day, or leave an offer if the company takes them.",
      "numbers": ["current_bid_cents", "tag_price_final_day_cents", "max_hammer_cents"]
    },
    {
      "id": "R18",
      "code": "TAG_PASS",
      "kind": "action",
      "priority": 38,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "fixed"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "tag_price_final_day_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Pass. Even at a last-day discount (about {tag_price_final_day_cents|usd}) this is above your ceiling of {max_hammer_cents|usd}.",
      "numbers": ["current_bid_cents", "tag_price_final_day_cents", "max_hammer_cents"]
    },
    {
      "id": "R19",
      "code": "BID_UP_TO_MAX",
      "kind": "action",
      "priority": 39,
      "confidence": "medium",
      "evidence": ["lee_malmendier_2011", "ockenfels_roth_2006"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "effective_close_type"}, "unknown"]}, {"!=": [{"var": "max_hammer_cents"}, null]}, {">": [{"var": "max_hammer_cents"}, 0]}, {"<=": [{"var": "next_min_bid_cents"}, {"var": "max_hammer_cents"}]}]},
      "text": "Closing rule not captured for this platform. Enter one max bid of {max_hammer_cents|usd} about {proxy_deadline_minutes_before_close} minutes before the close; that works whether or not the lot extends.",
      "numbers": ["max_hammer_cents", "headroom_cents", "minutes_to_close"]
    },
    {
      "id": "R20",
      "code": "NEED_VALUE",
      "kind": "action",
      "priority": 80,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"!": [{"var": "has_value"}]}, {"!": [{"var": "has_budget"}]}]}]},
      "text": "No ceiling yet. Add the median of recent SOLD prices (not asking prices) for this item in this condition, or the most you will pay, and PaddleUp will compute a walk-away number. Every $100 bid here costs about {cost_per_100_cents|usd} before pickup.",
      "numbers": ["cost_per_100_cents", "bp_pct", "tax_rate", "card_fee_rate"]
    },
    {
      "id": "R21",
      "code": "BUDGET_ONLY_CEILING",
      "kind": "warning",
      "priority": 81,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "bazerman_samuelson_1983"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"!": [{"var": "has_value"}]}, {"var": "has_budget"}]}]},
      "text": "Your ceiling ({max_hammer_cents|usd} hammer, {user_max_budget_cents|usd} invoice) comes only from your budget. It does not check whether the lot is worth that. Add a sold-comps value.",
      "numbers": ["max_hammer_cents", "user_max_budget_cents"]
    },
    {
      "id": "R30",
      "code": "ABOVE_VALUE_ALREADY",
      "kind": "warning",
      "priority": 50,
      "confidence": "high",
      "evidence": ["lee_malmendier_2011", "schneider_2016"],
      "when": {"and": [{"var": "is_open"}, {"var": "has_value"}, {">=": [{"var": "all_in_at_current_cents"}, {"var": "expected_resale_cents"}]}]},
      "text": "At the current bid you would already pay {all_in_at_current_cents|usd} all-in, at or above the {expected_resale_cents|usd} value you entered. In eBay field data a large share of auctions finish above the same item's fixed price on the same page. Check Buy It Now or retail before going further.",
      "numbers": ["all_in_at_current_cents", "expected_resale_cents"]
    },
    {
      "id": "R31",
      "code": "PICKUP_EATS_MARGIN",
      "kind": "warning",
      "priority": 51,
      "confidence": "medium",
      "evidence": ["gsa_terms", "wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"var": "has_value"}, {"var": "transport_known"}, {">": [{"var": "transport_share"}, {"var": "constants.transport_share_warn"}]}]}]},
      "text": "The pickup trip ({pickup_distance_miles} miles each way, about {transport_cents|usd}) is {transport_share|pct} of the expected resale value. It is already deducted from your ceiling; combine it with other lots at the same site or skip.",
      "numbers": ["pickup_distance_miles", "transport_cents", "transport_share"]
    },
    {
      "id": "R32",
      "code": "HERD_WARNING",
      "kind": "warning",
      "priority": 52,
      "confidence": "medium",
      "evidence": ["simonsohn_ariely_2008", "ku_galinsky_murnighan_2006"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_crowded"}]},
      "text": "Crowded lot ({bid_count} bids). Bidders herd into lots that already have bids even when the bids only reflect a low opening price, and pay more when they win them. The bid count is not evidence of quality; look for a quieter comparable lot.",
      "numbers": ["bid_count", "herd_bid_count"]
    },
    {
      "id": "R33",
      "code": "INSPECT_OR_SKIP",
      "kind": "warning",
      "priority": 53,
      "confidence": "medium",
      "evidence": ["lewis_2011", "nizard_thesis"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"==": [{"var": "image_count"}, 0]}, {"var": "high_value_risk"}]}]},
      "text": "No photos on a high-risk category. Sellers who can show quality usually do; inspect at preview or skip.",
      "numbers": ["image_count", "description_word_count"]
    },
    {
      "id": "R34",
      "code": "SLEEPER_CANDIDATE",
      "kind": "info",
      "priority": 54,
      "confidence": "medium",
      "evidence": ["lewis_2011", "nizard_thesis", "nyt_misspelling_2004", "sleeper_internal"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_quiet"}, {">=": [{"var": "image_count"}, 1]}, {"or": [{"var": "is_thin_listing"}, {"var": "is_few_photos"}]}]},
      "text": "Possible sleeper: a thin listing ({description_word_count} words, {image_count} photo(s)) with {bid_count} bid(s). Fewer photos and less text are associated with fewer bidders and lower prices, which is the opportunity, and with more condition risk, which your {uncertainty_haircut_rate|pct} risk haircut covers. Identify it from the photos before bidding.",
      "numbers": ["description_word_count", "image_count", "bid_count", "uncertainty_haircut_rate"]
    },
    {
      "id": "R35",
      "code": "PREMIUM_ASSUMED",
      "kind": "warning",
      "priority": 55,
      "confidence": "high",
      "evidence": ["govdeals_thirdparty", "wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {"var": "bp_assumed"}]},
      "text": "Buyer's premium was not captured for this lot; using {bp_pct}% ({bp_source}). Check the auction terms, because the premium moves your ceiling directly.",
      "numbers": ["bp_pct", "bp_source"]
    },
    {
      "id": "R36",
      "code": "TRUE_COST",
      "kind": "info",
      "priority": 56,
      "confidence": "high",
      "evidence": ["govdeals_thirdparty", "wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {">": [{"var": "cost_multiplier"}, 0]}]},
      "text": "Every $100 of hammer price costs about {cost_per_100_cents|usd} on the invoice ({bp_pct}% premium, {tax_rate|pct} tax, {card_fee_rate|pct} card fee), before pickup.",
      "numbers": ["cost_multiplier", "cost_per_100_cents", "bp_pct", "tax_rate", "card_fee_rate"]
    },
    {
      "id": "R37",
      "code": "EXTENDING_CLOSE_PRICES_HIGHER",
      "kind": "info",
      "priority": 57,
      "confidence": "medium",
      "evidence": ["glover_raviv_2012", "houser_wooders_2005", "overstock_softclose_2019"],
      "when": {"and": [{"var": "is_open"}, {"var": "is_extending_close"}]},
      "text": "Auctions that extend on late bids have finished higher than fixed-end auctions in the published comparisons, so expect less discount here and don't count on a last-second steal.",
      "numbers": ["window_min"]
    },
    {
      "id": "R38",
      "code": "GSA_INACTIVITY_AND_REMOVAL",
      "kind": "info",
      "priority": 58,
      "confidence": "high",
      "evidence": ["gsa_faq", "gsa_terms", "gsa_realestate_faq", "cbca_2007", "gsa_thirdparty"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "platform_base"}, "gsa"]}]},
      "text": "GSA: most lots close only after an inactivity period with no bids (see 'Bidding Details'), so a late bid just restarts it; GSA's real-estate FAQ adds that changing your own proxy bid restarts it too. If you win, pay within 2 business days and remove within 10 business days of the award email. Missing either can cost liquidated damages (reported as the greater of 20% or $200). GSA does not ship.",
      "numbers": ["window_min"]
    },
    {
      "id": "R39",
      "code": "WISCONSIN_SURPLUS_TERMS",
      "kind": "info",
      "priority": 59,
      "confidence": "high",
      "evidence": ["wisconsin_surplus_terms"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "platform_base"}, "wisconsin-surplus"]}]},
      "text": "Wisconsin Surplus: bids in the last 10 minutes extend the item by 10 minutes; a tiered buyer's fee is added; items left past the posted removal deadline cost $10 per day in storage.",
      "numbers": ["window_min", "bp_pct"]
    },
    {
      "id": "R40",
      "code": "GOV_REMOVAL_CHECK",
      "kind": "info",
      "priority": 60,
      "confidence": "medium",
      "evidence": ["public_surplus_extensions", "govdeals_thirdparty"],
      "when": {"and": [{"var": "is_open"}, {"in": [{"var": "platform_base"}, ["govdeals", "public-surplus", "municibid"]]}]},
      "text": "Government surplus: the selling agency sets payment and removal deadlines and whether it loads for you. Read them before bidding and plan the pickup (truck, trailer, helpers) first.",
      "numbers": ["pickup_distance_miles", "transport_cents"]
    },
    {
      "id": "R41",
      "code": "SF97_TITLE_CHECK",
      "kind": "warning",
      "priority": 61,
      "confidence": "high",
      "evidence": ["gsa_sf97", "gsa_faq"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"==": [{"var": "category"}, "vehicles"]}, {"==": [{"var": "platform_base"}, "gsa"]}]}]},
      "text": "Federal vehicle: the SF-97 is evidence of title only; you use it to title and register the vehicle with the state. GSA itself charges no sales tax, but the state may tax registered items such as vehicles; that tax is inside your {tax_rate|pct} assumption.",
      "numbers": ["tax_rate"]
    },
    {
      "id": "R42",
      "code": "VEHICLE_PAPERWORK_CHECK",
      "kind": "warning",
      "priority": 62,
      "confidence": "low",
      "evidence": [],
      "when": {"and": [{"var": "is_open"}, {"and": [{"==": [{"var": "category"}, "vehicles"]}, {"!=": [{"var": "platform_base"}, "gsa"]}]}]},
      "text": "Before bidding on a vehicle, confirm in the terms what paperwork you receive (title, bill of sale, or neither) and when. Not verified per platform.",
      "numbers": []
    },
    {
      "id": "R43",
      "code": "AIRCRAFT_REMOVAL_COSTS",
      "kind": "warning",
      "priority": 63,
      "confidence": "high",
      "evidence": ["gsa_aircraft_listing"],
      "when": {"and": [{"var": "is_open"}, {"==": [{"var": "category"}, "aircraft"]}]},
      "text": "Aircraft: disassembly, removal planning and transport are the buyer's cost and arrangement, and the government provides no ground support equipment. Listings may state the aircraft is not in FAA-flyable condition and comes without airworthiness documents. Price the removal before bidding.",
      "numbers": ["max_hammer_cents"]
    },
    {
      "id": "R44",
      "code": "WINNERS_CURSE_GUARD",
      "kind": "info",
      "priority": 64,
      "confidence": "high",
      "evidence": ["bazerman_samuelson_1983", "bajari_hortacsu_2003"],
      "when": {"and": [{"var": "is_open"}, {"and": [{"var": "has_value"}, {">=": [{"var": "uncertainty_haircut_rate"}, {"var": "constants.winners_curse_note_min_haircut"}]}]}]},
      "text": "This category's value is uncertain, so the winner is usually whoever overestimated it most. Your ceiling already deducts a {uncertainty_haircut_rate|pct} uncertainty haircut; don't bid past it.",
      "numbers": ["uncertainty_haircut_rate", "risk_reserve_cents"]
    },
    {
      "id": "R45",
      "code": "CLOSING_QUIET",
      "kind": "info",
      "priority": 65,
      "confidence": "medium",
      "evidence": ["sleeper_internal", "simonsohn_ariely_2008"],
      "when": {"and": [{"var": "is_open"}, {"<=": [{"var": "minutes_to_close"}, {"var": "constants.closing_quiet_minutes"}]}, {"var": "is_quiet"}]},
      "text": "Closes in {minutes_to_close|min} with {bid_count} bid(s): the crowd has not found it yet.",
      "numbers": ["minutes_to_close", "bid_count"]
    }
  ],
  "output_contract": {
    "per_lot": {
      "primary": "The fired rule of kind 'action' with the lowest priority number, or null.",
      "actions": "All fired rules of kind 'action', ascending priority.",
      "warnings": "All fired rules of kind 'warning', ascending priority.",
      "info": "All fired rules of kind 'info', ascending priority.",
      "each_item": {
        "code": "string",
        "rule_id": "string",
        "text": "rendered template",
        "numbers": "object: name -> value for every name listed in the rule's 'numbers'",
        "confidence": "high|medium|low",
        "evidence": "array of evidence_index ids"
      },
      "derived": "Every derived value, for display and debugging."
    },
    "template_syntax": "{name} inserts a value; {name|usd} renders integer cents as $1,234.56; {name|pct} renders a fraction as a percent (0.123 -> 12.3%); {name|min} renders minutes as whole minutes. Dotted names read constants. null renders as 'n/a'."
  },
  "evidence_index": {
    "roth_ockenfels_2002": "https://www.aeaweb.org/articles?id=10.1257%2F00028280260344632",
    "ariely_ockenfels_roth_2005": "https://ideas.repec.org/p/ces/ceswps/_987.html",
    "ockenfels_roth_2006": "https://www.sciencedirect.com/science/article/pii/S089982560500059X",
    "ely_hossain_2009": "https://www.aeaweb.org/articles?id=10.1257/mic.1.2.68",
    "gray_reiley_2013": "http://www.davidreiley.com/papers/BenefitsToSniping.pdf",
    "backus_et_al_2015": "https://www.nber.org/papers/w20942",
    "overstock_softclose_2019": "https://link.springer.com/article/10.1007/s11002-019-09487-7",
    "houser_wooders_2005": "https://ideas.repec.org/h/spr/sprchp/978-0-387-24243-9_6.html",
    "glover_raviv_2012": "https://www.sciencedirect.com/science/article/abs/pii/S0167268111002319",
    "lee_malmendier_2011": "https://www.aeaweb.org/articles?id=10.1257%2Faer.101.2.749",
    "schneider_2016": "https://www.aeaweb.org/articles?id=10.1257/aer.20120767",
    "bazerman_samuelson_1983": "https://www.cs.princeton.edu/courses/archive/spr09/cos444/papers/BazermanSamuelson83.pdf",
    "bajari_hortacsu_2003": "https://ideas.repec.org/a/rje/randje/v34y2003i2p329-55.html",
    "ku_malhotra_murnighan_2005": "https://econpapers.repec.org/RePEc:eee:jobhdp:v:96:y:2005:i:2:p:89-103",
    "heyman_orhun_ariely_2004": "https://www.sciencedirect.com/science/article/abs/pii/S1094996804701152",
    "ku_galinsky_murnighan_2006": "https://pubmed.ncbi.nlm.nih.gov/16784346/",
    "simonsohn_ariely_2008": "https://pubsonline.informs.org/doi/10.1287/mnsc.1080.0881",
    "simonsohn_2010": "https://pubsonline.informs.org/doi/abs/10.1287/mnsc.1100.1180",
    "lucking_reiley_2007": "https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1467-6451.2007.00309.x",
    "lewis_2011": "https://www.aeaweb.org/articles?id=10.1257%2Faer.101.4.1535",
    "nizard_thesis": "https://academicworks.cuny.edu/hc_sas_etds/1177/",
    "nyt_misspelling_2004": "https://www.math.utoronto.ca/mpugh/Teaching/Sci199_03/EBay_misspellings.htm",
    "katkar_reiley_2006": "https://www.nber.org/papers/w8183",
    "engelberg_williams_2009": "https://www.sciencedirect.com/science/article/abs/pii/S0167268109001504",
    "ebay_automatic_bidding": "https://www.ebay.com/help/buying/bidding/automatic-bidding?id=4014",
    "gsa_faq": "https://gsaauctions.gov/auctions/auction-faq",
    "gsa_terms": "https://gsaauctions.gov/auctions/terms-conditions",
    "gsa_realestate_faq": "https://realestatesales.gov/html/static/faq.htm",
    "gsa_thirdparty": "https://bidprowl.com/guides/gsa-auctions-faq",
    "cbca_2007": "https://www.cbca.gov/files/decisions/2007/PARKER_03-07-2007_426__GHULAM_H_SYED_508.pdf",
    "gsa_aircraft_listing": "https://www.gsaauctions.gov/auctions/preview/297688",
    "gsa_sf97": "https://www.gsa.gov/reference/forms/the-united-states-government-certificate-to-obtain-title-to-a-vehicle",
    "govdeals_thirdparty": "https://govauctions.app/guides/govdeals-faq",
    "public_surplus_extensions": "https://m.publicsurplus.com/sms/help/public/gloss_extension.html",
    "hibid_softclose_examples": "https://www.wnutting.com/HiBid%20-%20How%20HiBid%20Closing%20Works.pdf",
    "kbid_softclose": "https://www.k-bid.com/auction/29680/item/375-INFO?offset=243",
    "wisconsin_surplus_terms": "https://wisconsinsurplus.com/terms-2/",
    "maxsold_softclose": "https://support.maxsold.com/hc/en-us/articles/203144064-What-does-soft-close-mean",
    "auctionninja_extended": "https://support.auctionninja.com/knowledge/what-is-extended-bidding",
    "proxibid_timed": "https://support.proxibid.com/hc/en-gb/articles/360012856098-Timed-Auctions",
    "yesterdays_tractors_forum": "https://forums.yesterdaystractors.com/threads/proxibid-tips-please.1519535/",
    "sleeper_internal": "platform/supabase/migrations/0006_ranking_and_sleeper_fixes.sql",
    "internal_market_research": "platform/docs/05-market-research.md"
  }
};

/**
 * The label of each evidence_index source, transcribed from docs/06 section 11
 * ("Sources"), where every URL carries [SE], [SE-2nd] or [listed].
 *
 * bazerman_samuelson_1983 is SE-2nd although its index URL is the paper itself:
 * section 11 marks that PDF [listed] (never opened) and takes the numbers from a
 * secondary summary, which is how the doc labels every Bazerman & Samuelson claim.
 */
export const EVIDENCE_STATUS: Readonly<Record<string, EvidenceLabel>> = {
  roth_ockenfels_2002: 'SE',
  ariely_ockenfels_roth_2005: 'SE',
  ockenfels_roth_2006: 'SE',
  ely_hossain_2009: 'SE',
  gray_reiley_2013: 'SE',
  backus_et_al_2015: 'SE',
  overstock_softclose_2019: 'SE',
  houser_wooders_2005: 'SE',
  glover_raviv_2012: 'SE',
  lee_malmendier_2011: 'SE',
  schneider_2016: 'SE',
  bazerman_samuelson_1983: 'SE-2nd',
  bajari_hortacsu_2003: 'SE',
  ku_malhotra_murnighan_2005: 'SE',
  heyman_orhun_ariely_2004: 'SE',
  ku_galinsky_murnighan_2006: 'SE',
  simonsohn_ariely_2008: 'SE',
  simonsohn_2010: 'SE',
  lucking_reiley_2007: 'SE',
  lewis_2011: 'SE',
  nizard_thesis: 'SE',
  nyt_misspelling_2004: 'SE',
  katkar_reiley_2006: 'SE',
  engelberg_williams_2009: 'SE',
  ebay_automatic_bidding: 'SE',
  gsa_faq: 'SE',
  gsa_terms: 'SE',
  gsa_realestate_faq: 'SE',
  gsa_thirdparty: 'SE-2nd',
  cbca_2007: 'SE',
  gsa_aircraft_listing: 'SE',
  gsa_sf97: 'SE',
  govdeals_thirdparty: 'SE-2nd',
  public_surplus_extensions: 'SE',
  hibid_softclose_examples: 'SE',
  kbid_softclose: 'SE',
  wisconsin_surplus_terms: 'SE',
  maxsold_softclose: 'SE',
  auctionninja_extended: 'SE',
  proxibid_timed: 'SE',
  yesterdays_tractors_forum: 'SE',
  sleeper_internal: 'INTERNAL',
  internal_market_research: 'INTERNAL',
};

/**
 * Rules that cite no evidence still need a label. R00 is a product action
 * (record the result). R16-R18 rest on estate-sale practice that docs/06 sections
 * 5.6 and 6.5 mark UNVERIFIED, and R42 says "Not verified per platform".
 */
export const LABEL_FOR_RULES_WITHOUT_EVIDENCE: Readonly<Record<string, EvidenceLabel>> = {
  R00: 'DESIGN',
  R16: 'UNVERIFIED',
  R17: 'UNVERIFIED',
  R18: 'UNVERIFIED',
  R42: 'UNVERIFIED',
};
