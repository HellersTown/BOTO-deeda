# Auction aggregator platform

A centralised, zip-code-aware catalogue of federal, state, county, municipal,
private and estate auctions — with standing "hunts" that watch for things that do
not exist yet, and visual search that finds lots the cataloguer mis-described.

Working name pending; see [`docs/02-naming.md`](docs/02-naming.md). The brand is a
single config constant and this directory is named neutrally, so renaming is a
one-line change plus a `git mv`.

> **Note on this directory.** The repository root is `AgentHQ`, an unrelated
> AI-agent dashboard. This platform is self-contained under `platform/` and shares
> nothing with it.

---

## Read these in order

| Doc | What it answers |
|---|---|
| [`docs/00-architecture.md`](docs/00-architecture.md) | How it works, and **why the previous attempt stalled** (§0 — it was architectural, not a tooling limit) |
| [`docs/01-sources.md`](docs/01-sources.md) | Every source worth indexing, which ingestion method each needs, and what to build first |
| [`docs/02-naming.md`](docs/02-naming.md) | Name candidates with verified domain availability, and a recommendation |
| [`docs/03-legal-and-tos.md`](docs/03-legal-and-tos.md) | What is safe to crawl, what must be deep-linked, and what the paid tier can honestly promise |

Three ideas carry the whole design:

1. **Adapters are per-platform, not per-auction-house.** Twelve adapters covers
   thousands of houses, because almost every Wisconsin auctioneer runs on HiBid.
   Adding a new house is usually a database `INSERT`.
2. **Location is a disjunction, not a filter.** A lot is relevant if it is
   *drivable* **OR** *in a named state* **OR** *ships*. Every competitor ANDs these
   and that is exactly why good lots vanish.
3. **Crawl budget follows closing time.** A lot closing in eight minutes is polled
   every 30s; one closing in nine days, daily. Measured: 5,220 lots cost
   **25,000 requests/day** instead of 1,503,360 under uniform 5-minute polling.

---

## Status

### Done and verified

- **Schema applied** to the live Supabase project (`sfolywzqtxcdorjwnmsz`):
  17 tables, RLS, tier metering, entitlement view.
- **Extensions installed and confirmed:** `vector` 0.8.0 (pgvector), `postgis`
  3.3.7, `pg_cron` 1.6.4, `pgmq` 1.5.1, `pg_net`, `pg_trgm`, `unaccent`,
  `btree_gist`, `cube`, `earthdistance`.
  This is the answer to "how do we host a thing that runs 24/7": `pg_cron` +
  `pgmq` + `pg_net` means **there is nothing extra to host.**
- **Ingest primitives, 32 tests passing, zero dependencies:**
  - `money.ts` — currency parsing that never multiplies a float by 100, and
    returns `null` rather than guessing on ambiguous input.
  - `schedule.ts` — the adaptive poll ladder and failure backoff.
  - `jsonld.ts` — schema.org extraction, the ingestion rung the last attempt
    missed entirely.
- **Source registry** — 35 sources with per-source ingestion method, rate limits
  and a human `ingest_allowed` determination.

### Written, not yet applied

- `supabase/migrations/0005_search_functions.sql` — `search_lots()`,
  `match_lots_by_image()`, the sleeper score, `v_lot_detail`. Apply it manually or
  via the Supabase CLI.

### Not started

- Adapters: GSA, HiBid, Wisconsin Surplus, eBay, GovDeals.
- `postal_codes` seed — **blocks all radius search.** Needs the Census ZCTA
  gazetteer; see below.
- CLIP embedding pipeline.
- Web app.

---

## Two blockers that need you, not code

**1. `postal_codes` is empty, and radius search cannot work until it is seeded.**
The data is the US Census ZCTA gazetteer (public domain). It was not seeded here
because this container's egress policy blocks outbound HTTP, and **inventing zip
centroids is the one thing that must not be done** — a wrong coordinate silently
poisons every distance calculation and every alert built on one. Load it from the
Census gazetteer before enabling any geo feature.

**2. The eBay production keyset is disabled.** A keyset named `Waystock` exists
(`App ID: HellersT-W...c076`) but eBay's own notification says it is disabled and
must be enabled. Nothing eBay-related works until that is done in the developer
console.

---

## Running the tests

No install step, no build step, no dependencies. Node 22 runs TypeScript directly.

```bash
cd platform/packages/ingest
npm test          # -> 32 tests, 32 pass, 0 fail
```

Every adapter takes its `fetch` as an injected dependency, so tests run against
saved fixtures in `test/fixtures/` with no network at all. That is not only for
convenience: it is the only way these parsers can be verified in an environment
with no egress, and it is what makes HTML-rung sources tolerable long-term.

---

## Applying the database work

Migrations `0001`–`0004` are already applied. To apply the rest:

```bash
# via the Supabase CLI, against project sfolywzqtxcdorjwnmsz
supabase db push

# or paste 0005_search_functions.sql into the SQL editor, then:
#   seed/sources.sql      (safe: registers sources without authorising any crawl)
```

`seed/sources.sql` seeds every source with `robots_allows = null`, and the crawler
treats null as **do not crawl**. So loading it registers sources without
authorising a single HTTP request against any of them. A source becomes crawlable
only after its `robots.txt` has been fetched, the verdict recorded, and one passing
fixture captured.

---

## Layout

```
platform/
├── docs/
│   ├── 00-architecture.md      how it works, and why the last attempt stalled
│   ├── 01-sources.md           35 sources, ingestion method each
│   ├── 02-naming.md            names + verified domain availability
│   └── 03-legal-and-tos.md     crawling, images, bidding, licensing risk
├── supabase/
│   ├── migrations/
│   │   ├── 0001_extensions.sql        applied
│   │   ├── 0002_core_schema.sql       applied
│   │   ├── 0003_rls.sql               applied
│   │   ├── 0004_tiers_metering.sql    applied
│   │   └── 0005_search_functions.sql  NOT applied
│   └── seed/
│       └── sources.sql
└── packages/ingest/
    ├── src/{types,money,schedule,jsonld}.ts
    └── test/                    32 passing, no network required
```

---

## Tiers

Metering follows cost, and the costly thing is not the obvious one. Text hunts are
nearly free because the loop is inverted — each new lot is matched once against an
index of hunts, so cost is `O(new lots)` and barely grows with hunt count. What
actually scales per user is **vector work**: one HNSW probe per image-hunt per
ingest batch, plus vector storage. So photo hunts are the paid privilege, and
alert *latency* is the cleanest upgrade trigger because it costs nothing to give
away.

| | Free | Pro | Dealer |
|---|---|---|---|
| Active hunts | 3 | 25 | 250 |
| Photo-matched hunts | — | 10 | 100 |
| Alert latency | 1 hour | 60s | 30s |
| Watchlist | 25 | 500 | 5,000 |
| Rival intel | — | yes | yes |
| CSV / API | — | CSV | CSV + API |

Limits are enforced by database triggers, and the rival-intel paywall by an RLS
policy (`has_rival_intel()`) — **not** in the UI, because a limit that lives only
in the front end is a suggestion that anyone with the anon key can ignore.

**v1 paid tiers do not sell bid placement.** No public bidding API exists for
HiBid, Proxibid, GovDeals or Wisconsin Surplus; eBay's is Limited Release and needs
a signed contract. See `docs/03-legal-and-tos.md` §4.
