# Requirements traceability

This document re-checks every instruction the owner has given since the start of the project against what actually exists. It was written on 2026-09-28 because the owner asked for "a recheck of every prompt and make sure your current direction is focused."

**Status legend**

| Status | Meaning |
|---|---|
| **DONE** | Built and verified against real data or a real system. |
| **PARTIAL** | Some of it exists; the rest is named explicitly. |
| **NEXT** | In the current build sequence. |
| **LATER** | Sequenced behind something it depends on. |
| **BLOCKED** | Needs the owner, or an outside party, to act. |

"Verified" always means run against production or a live site, never against a fixture written from documentation. Documentation-based testing is exactly how the GSA adapter passed 24 tests while returning zero real lots.

## The instructions, one by one

| # | Instruction (owner's words, condensed) | Status | Evidence / what remains |
|---|---|---|---|
| 1 | Centralized auction aggregator, mobile + web | PARTIAL | The data platform is live in Supabase. The app UI has not been built yet (row 26). |
| 2 | Profiles and logins | PARTIAL | `profiles` table exists, auto-created on signup, with RLS. Column privileges were hardened after a privilege-escalation bug was found (0009). UI pending. |
| 3 | Manage bids; deep link to bid direct at snipe time | PARTIAL | The `watchlist` table (with private max bid) and per-lot `url` deep links exist. Reminders need the hunt/alert engine (row 21). No platform offers a bidding API except eBay's limited-release one, so "bid direct" means a deep link. |
| 4 | Alerts | LATER | The `alerts` table exists and users can only mark alerts read (0009). The alert sender needs the hunt engine. |
| 5 | Federal, state, local; filter by ZIP; Wisconsin + adjacent states | PARTIAL | PostGIS radius search is verified: "typewriter" within 10 mi of 53202 returns the Milwaukee lot at 0.90 mi, and the Kansas truck stays out of Wisconsin results. **The ZIP gazetteer is still empty in production (row 25).** |
| 6 | "Middleman fee" | LATER | We never touch payment, so no transaction fee is possible. The legitimate equivalent is affiliate commission, e.g. eBay Partner Network on eBay deep links. Needs the eBay keyset enabled (row 9). |
| 7 | Paid tiers | DONE (DB) | free 3 hunts / pro 25 / dealer 250. Enforced in the database; the tier column is writable by the service role only (0009). Downgrades pause the extra hunts (0008). |
| 8 | Competitor and app-review research | PARTIAL | `docs/05-market-research.md`. App-store and Reddit mining were cut short by the research tool's search budget; §8 of that report lists the follow-up queries. |
| 9 | eBay + Facebook Marketplace | PARTIAL | Facebook Marketplace and Craigslist are deep-link only, never crawled (policy + DB). eBay Browse API adapter pending, and **BLOCKED on the owner re-enabling the eBay production keyset.** |
| 10 | Hold wholesale | DONE | B-Stock, Liquidation.com and Nellis are registered but inactive. Enforced in production (0 wholesale sources active). |
| 11 | Better name | BLOCKED | PaddleUp recommended (`docs/02-naming.md`); owner decision pending. Crawler identity uses the domain we control: `WaystockBot/0.1 (+https://waystock.org/bot)`. |
| 12 | Monitor and scrape Wisconsin auction houses and estate sales by ZIP | PARTIAL | 46 sources registered, plus 181 Wisconsin sellers catalogued (`docs/07`). Only GSA is ingestible so far. The live probe (row 23) decides the rest. |
| 13 | 24/7 tool plus hosting | PARTIAL | Supabase hosts the DB and Edge Functions. The scheduler is built (0010: `claim_due_sources`). pg_cron wiring is NEXT. |
| 14 | See who is bidding against you | LATER | `bid_events` and `rivals` tables exist, paywalled by tier. Needs sources that publish bid history; GSA publishes bidder **counts** only. |
| 15 | Industry bidding strategies | PARTIAL | `docs/06-bidding-strategies.md`: 21 strategies, a max-bid formula, and a JSON rules spec. The strategy engine itself is NEXT. |
| 16 | Natural-language search ("DJI drone with thermal") | LATER | Design: parse → expand ("thermal" → Mavic 3T, M30T, H20T, XT2...) → full-text + semantic ranking. |
| 17 | Image search (coins, gems, sleepers) | LATER | `lot_images.clip_embedding` + HNSW index and `match_lots_by_image` exist. Needs an embedding provider (owner-supplied key) or an in-house worker. |
| 18 | Self-sufficiency theme | LATER | Design language for the UI (row 26). |
| 19 | Federal/state/local/private; private houses matter | PARTIAL | Source registry covers all tiers. Private houses mostly sit on HiBid, which blocks datacenter clients (`docs/08`); see row 32. |
| 20 | The earlier Waystock UI had connection problems; waystock.org | DONE (diagnosed) | Cause: client-side `VITE_` calls straight to sources, from datacenter/browser contexts the sources block. Fixed by design: sources are only contacted server-side by the scheduler, and the app reads our own database. |
| 21 | Tier = number of standing searches; searches run even for items that don't exist yet | PARTIAL | Limits are enforced in the DB. The hunt matcher (new/changed lots → `hunt_matches` → alerts) is NEXT. It keys on `lots.updated_at`, which 0010 moves only on a material change, so unchanged lots never re-alert. |
| 22 | Auto mode | DONE | Owner set it. |
| 23 | Run the live probe from Supabase | NEXT | `source_probes` table and `record_source_probe` exist (0010). The probe function is being written now. |
| 24 | Fix the original 23 sources | DONE | 23 legacy rows reconciled in place, ids preserved, snapshot in `archive`. 46 sources, 0 duplicates. |
| 25 | Load Census ZIP data for Wisconsin | NEXT | Loads the national file, which includes Wisconsin: radius search from a border town (Beloit, Superior, Marinette) needs the neighbouring state's ZIPs. |
| 26 | Use Claude Design for the UI; profiles, logins, bid management, keyword + image hunts, a per-profile management UI | LATER | Starts after the data platform is real, so the design is built on real data. |
| 27 | Market research on competitors before building the app | DONE | `docs/05`, completed before any UI work. |
| 28 | Ping monitored sites at least hourly; host internal data for active searchers | PARTIAL | DB-enforced: `sources_hourly_floor` rejects any cadence over 60 minutes (verified), and failure backoff is capped at 60 minutes (verified). Searches run against our own hosted copy. The cron that drives it is NEXT. |
| 29 | Bidding strategies from professional resellers and auctioneers | PARTIAL | Research done (row 15). Engine NEXT. Practitioner rules of thumb are UNVERIFIED and will not be shown as fact. |
| 30 | Natural-language search that contextualizes a description, with image search alongside | LATER | Rows 16 and 17. |
| 31 | Every federal, state, local, private and estate source; hold wholesale | PARTIAL | See rows 12 and 19. |
| 32 | Contact live sites and verify the tool works | PARTIAL | Live contact so far: the GSA API (678 records). The probe (row 23) covers every source, and GSA ingest runs end to end in production. |

## Direction check: is the current work focused?

The current sequence, and why each step comes before the next:

1. **Census ZIPs (row 25).** Without them radius search returns nothing, however many lots exist.
2. **GSA ingest in production (rows 31–32).** The first real, lawful, national lot feed, and it includes Wisconsin lots. It also proves the write path (0010) works outside a test.
3. **Live probe of every source (row 23).** This replaces third-party reports of who blocks us with first-hand evidence from our own crawler identity. It decides which adapters are worth building.
4. **pg_cron (row 28).** Makes rows 2–3 run hourly without anyone present.
5. **Adapters for sources the probe shows are open**, plus deep-link builders for those that block us.
6. **Hunt matcher + alerts (rows 4, 21), strategy engine (rows 15, 29), NL + image search (row 30).**
7. **Claude Design UI, then the app (rows 1, 2, 3, 26).**
8. **End-to-end verification against live sites (row 32).**

Nothing in flight is off-requirement. The one real risk to the owner's goal is coverage: the platforms holding most Wisconsin private-house inventory (HiBid, GovDeals) reportedly refuse datacenter clients. The lawful answers are deep links, licensed data (BidProwl, GovAuctions.app, Municibid's official MCP server) and partnerships, never bypassing bot protection. The probe will confirm or refute the block first-hand before any of that is decided.
