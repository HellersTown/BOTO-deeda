# Requirements traceability

This document re-checks every instruction the owner has given against what actually exists. It was first written on 2026-09-28, when the owner asked for "a recheck of every prompt and make sure your current direction is focused". It was brought up to date on 2026-09-30.

**Status legend**

| Status | Meaning |
|---|---|
| **DONE** | Built and verified against real data or a real system. |
| **PARTIAL** | Some of it exists; the rest is named explicitly. |
| **IN PROGRESS** | Being built now. |
| **LATER** | Sequenced behind something it depends on. |
| **BLOCKED** | Needs the owner, or an outside party, to act. |

"Verified" always means run against production or a live site, never against a fixture written from documentation. Documentation-based testing is how the GSA adapter once passed 24 tests while returning zero real lots.

## The instructions, one by one

| # | Instruction (owner's words, condensed) | Status | Evidence / what remains |
|---|---|---|---|
| 1 | Centralized auction aggregator, mobile + web | PARTIAL | The data platform is live in Supabase. `platform/web` is an installable web app (PWA): search, lot detail, hunts, bids, alerts, profile. It is not deployed to a public URL yet, and is being restyled to the approved concept (row 34). |
| 2 | Profiles and logins | DONE | Supabase Auth (magic link and password) and `profiles` with RLS. The app has sign-in, a profile page (home ZIP, radius, notifications, quiet hours, plan) and an auth callback. Column privileges are hardened (0009). |
| 3 | Manage bids; deep link to bid direct at snipe time | DONE | The Bids page tracks watching, bid placed and closed lots, with exposure against a budget. "Bid on <source>" opens the lot on the auction's own site. No platform offers a bidding API except eBay's limited-release one, so "bid direct" is a deep link. |
| 4 | Alerts | PARTIAL | In-app alerts are live (Realtime, unread badge): hunt matches, hunt digests, closing-soon reminders, outbid and sold notices (0013), queued every 30 s. **Email alerts are queued but not sent: BLOCKED on an email provider key (e.g. Resend).** Web push is not built. |
| 5 | Federal, state, local; filter by ZIP; Wisconsin + adjacent states | DONE | 41,118 US ZIPs loaded (national, so border towns reach the next state). Radius search is verified on real rows. Lots that give only a city and a declared state are placed from 68,630 Census places (0016, 0017), and each point is labelled so approximate distances can be shown as such. |
| 6 | "Middleman fee" | LATER | We never touch payment, so no transaction fee is possible. The legitimate equivalent is affiliate commission, e.g. eBay Partner Network on eBay deep links. Needs the eBay keyset enabled (row 9). |
| 7 | Paid tiers | DONE | Free 3 hunts / Pro 25 / Dealer 250, with alert latency by tier (1 h / 1 min / 30 s). Enforced in the database; only the service role can write `tier` (0009); downgrades pause the extra hunts (0008). Display names in the concept: Traveler, Outfitter, Quartermaster. |
| 8 | Competitor and app-review research | PARTIAL | `docs/05-market-research.md`. App-store and Reddit mining were cut short by the research tool's search budget; §8 of that report lists the follow-up queries. |
| 9 | eBay + Facebook Marketplace | PARTIAL | Facebook Marketplace and Craigslist are deep-link only, never crawled (policy + DB). **eBay is BLOCKED on the owner re-enabling the eBay production keyset;** the Browse API is the only eBay route. |
| 10 | Hold wholesale | DONE | B-Stock, Liquidation.com and Nellis are registered but inactive. |
| 11 | Better name | DONE | The owner chose **Skeuos** (2026-09-30). The brand idea is equipping for a long journey, and the app never explains the name (row 34). The crawler still identifies as `WaystockBot/0.1 (+https://waystock.org/bot)` until a Skeuos domain exists. |
| 12 | Monitor and scrape Wisconsin auction houses and estate sales by ZIP | IN PROGRESS | 46 sources registered, plus 181 Wisconsin sellers catalogued (`docs/07`). GSA is ingested. Connectors for the open Wisconsin sources are being built from live pages (row 33). |
| 13 | 24/7 tool plus hosting | DONE | Supabase hosts the DB and Edge Functions. 7 pg_cron jobs (0014): hourly probe, crawl every 5 min (claims only due sources), hunt matcher and watch alerts every 30 s, close expired, sleeper refresh, housekeeping. |
| 14 | See who is bidding against you | LATER | `bid_events` and `rivals` tables exist, paywalled by tier. Needs sources that publish bid history; GSA publishes bidder counts only. |
| 15 | Industry bidding strategies | DONE | `docs/06` (21 strategies, a max-bid formula, a JSON rules spec) and `packages/strategy`, the engine (168 tests). The lot page shows the walk-away number ("count the cost"), what to type in, and the plan, with unverified values tagged. |
| 16 | Natural-language search ("DJI drone with thermal") | DONE | `packages/query` (100 tests) turns a description into search parameters and a hunt. Search and hunts use its synonym and model-variant groups (0018): "chevy pickup truck" found 0 live lots before and 17 after. |
| 17 | Image search (coins, gems, sleepers) | BLOCKED | `lot_images.clip_embedding`, an HNSW index and `match_lots_by_image` exist, and image hunts are wired into the matcher. There is no embedding provider: it needs an owner-supplied key (an image-embedding API, or a vision model to describe photos). |
| 18 | Self-sufficiency theme | DONE (design) | Expressed through the concept (row 34): tools, provisions and gear; onboarding asks what you are gathering (generators, woodstoves, canning, fencing, tractors...). |
| 19 | Federal/state/local/private; private houses matter | IN PROGRESS | Our own probe found HiBid open to our crawler (earlier third-party reports said otherwise). The HiBid adapter covers most Wisconsin private houses (row 33). |
| 20 | The earlier Waystock UI had connection problems | DONE (diagnosed) | Cause: client-side calls straight to sources, which block browsers and datacenters. Fixed by design: sources are contacted only server-side by the scheduler; the app reads our own database. |
| 21 | Tier = number of standing searches; searches run for items that don't exist yet | DONE | The hunt matcher runs every 30 s within each tier's latency, sends one digest on a hunt's first run, then one alert per new match (up to 5) plus a digest for the rest. It keys on `lots.updated_at`, which moves only on a material change, so unchanged lots never re-alert. |
| 22 | Auto mode | DONE | Owner set it. |
| 23 | Run the live probe from Supabase | DONE | `probe-sources` runs hourly: 41 contactable sources, each verdict stored with its evidence (open 23, blocked 15, unreachable 2, needs a key 1). |
| 24 | Fix the original 23 sources | DONE | Reconciled in place, ids preserved, snapshot in `archive`. |
| 25 | Load Census ZIP data for Wisconsin | DONE | National file loaded (row 5). |
| 26 | Use Claude Design for the UI; profiles, logins, bid management, hunts | DONE | The Claude Design canvas (https://claude.ai/artifact/ASWviqkVc5jc6P7S4epjeW, copies in `docs/design`) and the app built from it (row 1). |
| 27 | Market research on competitors before building the app | DONE | `docs/05`, completed before any UI work. |
| 28 | Ping monitored sites at least hourly; host internal data for active searchers | DONE | Hourly probe of every source; the database refuses any crawl cadence over 60 minutes; searches run against our own hosted copy. |
| 29 | Bidding strategies from professional resellers and auctioneers | DONE | Row 15. Practitioner rules of thumb are tagged UNVERIFIED and never shown as fact. |
| 30 | Natural-language search with image search alongside | PARTIAL | NL search done (row 16); image search blocked (row 17). |
| 31 | Every federal, state, local, private and estate source; hold wholesale | IN PROGRESS | Rows 12, 19 and 33. |
| 32 | Contact live sites and verify the tool works | PARTIAL | Every source is contacted hourly. GSA ingest is live (1,009 lots). Each new adapter is built from pages fetched live through our crawler (`inspect-page`) and must be verified by a live crawl before it counts. |
| 33 | "Begin building out every single auction site, starting with federal, state, local and private auctions in Wisconsin" (2026-09-30) | IN PROGRESS | Order: federal (GovPlanet), state (Wisconsin Surplus Online Auction), local (Public Surplus, Municibid, PropertyRoom), private (HiBid, Hansen, Proxibid, BidSpotter). Every adapter request passes the crawl gate (robots.txt per URL, per-host pacing, stop on any bot-manager challenge). |
| 34 | Name it Skeuos; don't explain the name in the app; build the concept designs on its meaning (God's people equipping themselves before a long journey) | PARTIAL | Concept designs published: brand board ("Provisioned": the pack mark, pine / ember / brass / canvas, Zilla Slab / Public Sans / IBM Plex Mono), signature pieces and voice, 11 screens including onboarding ("Before you set out") and the pickup run. The app's rebrand to match is in progress; the /about page is being removed. |
| 35 | "Stop asking me to commit. Just do it." | DONE | Work is committed and pushed as it is finished. |
| 36 | Full Supabase permissions (2026-09-30) | DONE | Used for migrations 0016 to 0018, the gazetteer load and deploys. |

## Direction check

Coverage is the product. The work in flight, in order:

1. **Wisconsin connectors (row 33).** The adapters are built from live pages, then integrated behind the crawl gate, deployed, and verified by a live crawl.
2. **The app rebrand (row 34),** then a public deployment of the app.
3. **Blocked on the owner:**
   - an email provider key (row 4);
   - the eBay keyset (row 9);
   - an image embedding or vision key (row 17);
   - a GSA API key, to replace the shared demo key;
   - a Skeuos domain for the crawler's identity (row 11).

Nothing in flight is off-requirement. The lawful answer to sites that refuse our crawler stays the same: deep links, licensed data, partnerships. Never bypassing bot protection.
