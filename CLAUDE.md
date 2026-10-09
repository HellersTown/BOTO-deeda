# CLAUDE.md

This repository holds two unrelated projects:

- **Skeuos** is under `platform/`. It is an auction aggregator PWA, live at waystock.org, with Supabase project `sfolywzqtxcdorjwnmsz`.
- **AgentHQ** is everything else at the root. It is deployed on Netlify.

## Working on Skeuos (`platform/`)

Read `platform/docs/12-session-handoff.md` before anything else. It has the
identifiers, the live state, how migrations and deploys are done, and what is
waiting on the owner. Then read `platform/docs/11-database-load.md`.

Hard rules. A new session does not relitigate them:

- **Branch.** Work on `claude/waystock-auction-aggregator-66n8dv`, draft PR #1. Commit and push without asking.
- **Hourly watch.** Every listing's price and bids are watched at least hourly (the `sources_hourly_floor` CHECK). Only the owner relaxes that.
- **Held sources.** Never turn on a source held on its terms (`ingest_allowed = false`, including Wisconsin Surplus, HiBid, Public Surplus and Municibid) without the operator's written permission. No route around this.
- **Deep links only** for Facebook Marketplace and Craigslist. Never log in to scrape, never bypass bot protection, and read robots.txt and the terms first.
- **Secrets.** Never read env files or decrypt env values or secrets.
- **Destructive SQL** (DELETE, DROP, TRUNCATE) needs the owner's confirmation. Never read server files through SQL.
- **The name.** The app never explains its name.
