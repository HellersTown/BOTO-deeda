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
- **Search functions applied** (`0005`): `search_lots()`, `match_lots_by_image()`,
  `compute_sleeper()`, `refresh_sleeper_scores()`, `v_lot_detail`.
- **Ingest primitives and two adapters, 79 tests passing, zero dependencies:**
  - `money.ts` — currency parsing that never multiplies a float by 100, and
    returns `null` rather than guessing on ambiguous input.
  - `schedule.ts` — the adaptive poll ladder and failure backoff.
  - `jsonld.ts` — schema.org extraction, the ingestion rung the last attempt
    missed entirely.
  - `adapters/gsa.ts` — federal surplus, written against the **real OpenAPI spec**
    from `github.com/GSA/auctions_api`, not guessed.
  - `adapters/hibid.ts` — the platform adapter, with runtime capability detection.
- **Source registry** — 35 sources with per-source ingestion method, rate limits
  and a human `ingest_allowed` determination.

### What the GSA spec forced, each of which would have been a silent bug

Reading the actual spec rather than assuming changed three things:

1. **`PropertyState` and `LocationST` are different fields.** Property\* is where
   the item physically sits; Location\* is the selling agency. A generator in
   Milwaukee can be sold by a GSA region in Philadelphia. Mapping the wrong one
   into `pickup_state` is *exactly* how a Wisconsin buyer never sees Wisconsin
   inventory — the federal API independently validates the three-location split in
   the schema.
2. **`AuctionStatus` is one character where a space is meaningful** — `A`=Active,
   `P`=Preview, `' '`=Scheduled. So `status.trim()` silently destroys the Scheduled
   signal. And there is **no closed value at all**, so closure must be derived from
   `AucEndDt`, never from the status.
3. **`AucEndDt` is 10 characters — a date with no time.** Combined with
   `InactivityTime` (soft-close extension in minutes), the true close moment is
   genuinely indeterminate from the API. Lots carry
   `raw._meta.closeTimePrecise: false` so the UI cannot render a second-by-second
   countdown it has no right to. **GSA cannot drive a 30-second snipe alert without
   also scraping `ItemDescURL`.**

It also corrected a guess in the seed file: the base URL is
`api.gsa.gov/assets/gsaauctions/v2`, not the `gsa-auctions/v1` originally written.
Limits are 5,000 calls/day and 5 per 5 seconds, and the endpoint takes **no filter
parameters** — so one request returns every listing and filtering happens in our
database. That is a feature: one request per crawl cycle, no pagination.

### The HiBid adapter's honest caveat

This container's egress is blocked, so **no live HiBid page could be fetched** and
its DOM specifics are unverified. Rather than guess selectors, the adapter
*measures*: `probeTenant()` fetches one page and decides which ingestion rung the
tenant belongs on (`json_ld` → `html` → `headless` → `manual`), then records the
verdict. That is the better design regardless — HiBid can change its markup, and a
probe notices where a hardcoded selector returns zero rows for three weeks.

Extraction keys on `/catalog/{id}/` link shape rather than CSS classes, because a
routing contract is far more stable than a class name across a restyle.

### Not started

- Adapters: Wisconsin Surplus, eBay, GovDeals, Public Surplus.
- The worker/fetcher that enforces robots and rate limits (adapters take `fetch`
  injected; nothing yet supplies the production implementation).
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

Migrations `0001`–`0005` are all applied. What remains is the seed:

```bash
# Load the source registry (35 rows) against project sfolywzqtxcdorjwnmsz.
# Safe: registers sources without authorising a single crawl. See below.
supabase db execute --file supabase/seed/sources.sql

# or paste supabase/seed/sources.sql into the Supabase SQL editor
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
│   │   └── 0005_search_functions.sql  applied
│   └── seed/
│       └── sources.sql
└── packages/ingest/
    ├── src/
    │   ├── {types,money,schedule,jsonld}.ts
    │   └── adapters/
    │       ├── gsa.ts           written against the real OpenAPI spec
    │       └── hibid.ts         platform adapter + runtime capability probe
    └── test/                    79 passing, no network required
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
