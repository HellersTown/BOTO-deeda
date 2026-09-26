# Architecture

How the thing actually works, and why each choice is the one that survives contact
with reality.

---

## 0. Why the last attempt stalled

This matters because the fix is architectural, not a matter of better tools.

Evidence from the existing `waystock` Vercel project:

| Env var | What it tells us |
|---|---|
| `VITE_EBAY_APP_ID` | eBay was called **from the browser** |
| `VITE_ANTHROPIC_KEY` | the Anthropic key shipped **in the client bundle** |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Supabase was wired up |
| `BROWSERLESS_TOKEN` | a headless browser was the scraping workaround |
| `GSA_API_KEY` | a real GSA Auctions key was obtained |

And in the database: two tables, `inventory` and `sources`, **both with zero rows.**

That is a complete diagnosis. Anything prefixed `VITE_` is compiled into the
JavaScript the browser downloads. So the design was: browser → auction site. That
cannot work, for three independent reasons, none of which are about model
capability:

1. **CORS.** A browser will not let page JS read a cross-origin response unless
   that origin opts in with `Access-Control-Allow-Origin`. No auction site does.
   The request goes out and the response is thrown away by the browser itself.
2. **Secret exposure.** `VITE_ANTHROPIC_KEY` in a client bundle is a published
   credential. Anyone who opens devtools has it.
3. **No continuity.** A browser tab only runs while somebody is looking at it.
   "Monitors 24/7" is definitionally impossible in a front-end.

`BROWSERLESS_TOKEN` is the tell: reaching for a remote headless browser is what
you do when you have concluded HTTP fetching is impossible. It is not impossible.
It was blocked by running in the wrong place.

**The fix:** every outbound fetch moves server-side. Nothing about the data
problem was hard; the code was just standing in a place where it was not allowed
to read.

---

## 1. The leverage insight: adapters are per-PLATFORM, not per-auction-house

This is the single most important decision in the document, and getting it wrong
is what turns an aggregator into an infinite treadmill.

There are thousands of auction houses in the United States. There are roughly a
dozen pieces of software they run on. Observed directly:

```
hameleauctions.hibid.com          Hamele Auction Service    (Central WI)
hansenonlineauction.hibid.com     Hansen Auction & Realty
auctionwi.hibid.com               Wisconsin Auction Company
bids.beloitauction.com            Beloit Auction & Realty   <-- white-label, same platform
hibid.com/company/72559/...       the same house, indexed centrally
```

Three of those are `*.hibid.com` subdomains. The fourth is a custom domain
serving the same underlying platform. A naive crawler sees four websites. A
correct crawler sees **one platform with four tenants.**

So the unit of engineering is the platform adapter, and the unit of configuration
is the tenant. Twelve adapters covers most of the country:

| Platform | Who runs on it | Notes |
|---|---|---|
| **HiBid / AuctionFlex** | the bulk of small-to-mid US auctioneers, incl. nearly every WI house | the highest-leverage adapter by an order of magnitude |
| **Proxibid** | mid/large houses, equipment | |
| **AuctionMethod** | independents | |
| **BidWrangler** | independents, farm/estate | |
| **Auction Mobility** | art, antiques, higher end | |
| **Wavebid** | estate/consignment | |
| **EquipmentFacts / AuctionTime** | Sandhills; ag + construction | |
| **Invaluable / LiveAuctioneers** | art, antiques, collectibles | already aggregators themselves |
| **GovDeals / Liquidity Services** | county, municipal, `AllSurplus`, `GovPlanet` | |
| **Public Surplus** | schools, municipalities | |
| **GSA Auctions** | federal | **documented public API** |
| **Custom .NET** | `bid.wisconsinsurplus.com` and similar | per-tenant work, unavoidable |

Corollary worth stating plainly: **onboarding a new Wisconsin auction house is
usually a database INSERT, not a code change.** That is the difference between a
product and a treadmill.

Platform detection is itself automatable — fingerprint response headers, script
bundle paths and DOM markers, then store the verdict on `sources.platform`. A new
source gets classified on first contact and routed to the right adapter.

---

## 2. Ingestion: a strict preference ladder

Every source is assigned the **cheapest method that works**, recorded in
`sources.ingest`. Never reach down the ladder when a higher rung is available.

### Rung 1 — `official_api`
Documented, keyed, stable, explicitly permitted.
- **GSA Auctions** — public GET API, JSON and XML, federal surplus across all
  agencies. A key already exists (`GSA_API_KEY`).
- **eBay Browse API** — full auction search. A production keyset already exists
  but **is currently disabled** and needs activating.

### Rung 2 — `json_ld`
**The most underrated rung, and the one the previous attempt missed entirely.**

Auction sites want Google to index their lots, so they voluntarily publish
machine-readable `schema.org` markup:

```html
<script type="application/ld+json">
{"@type":"Product","name":"DJI Mavic 3T Thermal",
 "offers":{"@type":"Offer","price":"1450.00","priceCurrency":"USD",
           "availabilityEnds":"2026-10-04T23:00:00-05:00"}}
</script>
```

That is clean, structured, versioned data, placed there on purpose for machines
to read. Parsing it is not fragile HTML scraping — it is consuming a published
feed that happens to be embedded in a page. Always check for this before writing
a single CSS selector.

### Rung 3 — `internal_json`
Modern auction platforms are single-page apps, which means the site's own front
end already calls a JSON endpoint to render the lot grid. Call the same endpoint.
You get typed data with no markup parsing, and it breaks far less often than HTML
because the site's own app depends on it.

### Rung 4 — `rss` / `sitemap`
HiBid and others expose RSS per auctioneer. `sitemap.xml` is how you *discover*
lot URLs cheaply and detect new ones without crawling category pages.

### Rung 5 — `html`
CSS/XPath extraction. Brittle. Acceptable, but every such source needs a golden
fixture test (see §7) because it will break silently.

### Rung 6 — `headless`
A real browser, via the existing Browserless token. Costs roughly 100x a plain
fetch in time and money. Justified only for a genuinely JS-gated source that is
worth the expense.

### Rung 0 — `deeplink_only`
Some sources must **not** be ingested. We store the search-URL template and send
the user there with a tap. Facebook Marketplace is the clear case: no public API,
scraping violates its terms, and it is aggressively defended. Pretending
otherwise is how a platform gets itself sued and blocked. A well-built deep link
is genuinely useful and carries zero legal exposure.

---

## 3. The scheduler: crawl budget follows closing time

Uniform polling is the mistake that gets you rate-limited and stale at the same
time. A lot closing in eight minutes and a lot closing in nine days do not
deserve equal attention.

```
seconds_to_close        poll interval     why
─────────────────────────────────────────────────────────────────────
< 10 minutes            30 s              the snipe window; price moves now
10-60 minutes           2 min             bidding is live
1-6 hours               15 min
6-48 hours              1 hour
2-14 days               6 hours
> 14 days               24 hours
closed                  once, to record the final price
```

This is the whole trick. It concentrates request budget on the handful of lots
where the data is changing and leaves the long tail alone, which is also exactly
what a well-behaved crawler looks like from the far end.

Mechanically, with no server to host:

```
pg_cron  (every minute)
   └─ selects due sources / lots by the ladder above
        └─ pgmq.send()  — durable job queue, inside Postgres
             └─ Edge Function worker consumes the batch
                  ├─ fetch  (respecting robots + rate_limit_rpm)
                  ├─ normalize to the canonical lot shape
                  ├─ upsert on (source_id, external_id)
                  ├─ enqueue new images for embedding
                  └─ write crawl_runs + source_health
```

`pg_cron`, `pgmq` and `pg_net` are all installed and verified on the project. So
"a tool that runs 24/7 and updates itself" needs **no extra infrastructure** —
the database is the scheduler and the queue. That answers the hosting question:
there is nothing additional to host.

Backpressure and politeness are properties of the queue, not of the crawler:
`sources.rate_limit_rpm` caps per-host concurrency, and
`consecutive_failures` drives exponential backoff so a struggling small
auctioneer's site is never hammered.

---

## 4. Location: a disjunction, not a filter

The requirement, restated precisely: *find auctions with lots relevant to a
Wisconsin buyer, including auctions that never declare Wisconsin.*

Every existing site models location as one field, and that is why they fail. Three
distinct things get flattened into one:

- A federal surplus lot **physically in Milwaukee**, listed by an agency in
  Virginia, on a nationwide platform, tagged `VA`.
- An **online-only auction with no address at all** that ships anywhere, so it is
  exactly as buyable from Beaver Dam as from Boston.
- A **small private house in Fond du Lac** that never tags its state, because
  every one of its customers already knows where it is.

So the schema keeps them separate — `pickup_*`, `seller_*`, and the auction
house's own location are different columns — and a lot is relevant if **any** of
these is true:

1. it is within driving radius (real PostGIS distance from a zip centroid), **OR**
2. it is in a state the user named (declared location, where one exists), **OR**
3. it ships (geography simply does not apply)

Written as ANDed filters — which is what every competitor does — the good lots
disappear. Written as a disjunction, they surface. `search_lots()` returns
`match_basis` (`nearby` / `in_state` / `ships_to_you`) on every row so the UI can
say *why* something is in the list, which is what stops a disjunction from feeling
like noise.

Zip centroids live in our own `postal_codes` table, so radius search never calls a
geocoder on the hot path.

---

## 5. Search: three layers over one corpus

A user saying *"I want a DJI drone with thermal"* is doing three different
searches at once, and only the third one is hard.

**Layer 1 — intent parsing.** The phrase goes server-side to Claude with a JSON
schema, producing a structured hunt:

```json
{"category":"drone","brands":["DJI"],
 "required_terms":["thermal","radiometric"],
 "exclude_keywords":["case only","battery only","parts"],
 "max_price_cents":250000}
```

The parse is stored on `hunts.parsed` so it is auditable and editable. The user
can see and correct what we thought they meant, which matters because they will
sometimes be right and we will sometimes be wrong.

`exclude_keywords` deserves emphasis: in auction data the noise is systematic.
Search "DJI Mavic" and you get controllers, empty cases, single batteries and
"for parts" shells. Learned negative terms are worth more than better ranking.

**Layer 2 — lexical.** Postgres full-text search with weighted fields (title
beats description) plus `pg_trgm` for typo tolerance. Handles most queries and
costs almost nothing.

**Layer 3 — visual.** The interesting one. See §6.

---

## 6. Image search: the feature nobody else has

The premise: **the listing text is unreliable, and that unreliability is the
opportunity.** A coin lot catalogued as "lot of 12 wheat pennies" may contain a
1909-S VDB. The cataloguer is not lying; they are working fast and are not a
numismatist. Every existing platform indexes only what the cataloguer typed, so
they are structurally blind to exactly the lots worth finding.

Mechanism:

1. Every lot photo gets a CLIP embedding (ViT-L/14, 768-d) stored in
   `lot_images.clip_embedding`, indexed with HNSW under cosine distance.
   HNSW, not IVFFlat: the table grows continuously and IVFFlat would need
   periodic retraining.
2. One row per image, deliberately. A coin's obverse and reverse are different
   vectors; either matching is a hit.
3. The user supplies a reference — a photo, or a text description turned into the
   same embedding space — and we rank **on pixels**, ignoring the seller's words.
4. A reference embedding can be stored on a hunt, making it a standing visual
   order: *"tell me whenever something that looks like this appears anywhere."*

The arbitrage signal is then directly computable, and this is the part worth
building the company on:

```
high visual similarity  AND  near-empty description  AND  low current bid
```

Which is to say: *the photo says one thing, the catalogue entry says nothing, and
the price reflects the catalogue entry.* `match_lots_by_image()` returns that as
`underdescribed`.

Also cheap and worth doing: a 64-bit perceptual hash per image. It costs almost
nothing and catches the same photo reused across sources, which is how you dedupe
one lot appearing on both an auctioneer's own site and their HiBid mirror, and how
you spot relists of something that failed to sell.

For coins specifically, the pipeline extends naturally: detect and crop the coin,
OCR the date and mintmark, match obverse and reverse against a reference set. A
"sleeper" is almost always a date or variety the cataloguer did not record.

---

## 7. Knowing when a parser has quietly died

The characteristic failure of an aggregator is not an outage. It is a parser that
keeps returning rows, and the rows are wrong or empty, and nobody notices for
three weeks. By then trust is gone.

So every run writes to `crawl_runs`, and `source_health` tracks the *shape* of
what came back:

- `drift_ratio` = this run's lot count ÷ the rolling median. Alert below 0.3 or
  above 3.0.
- `null_rate_price`, `null_rate_image`, `null_rate_close` — a selector that
  silently stopped matching shows up as a null-rate spike long before a human
  notices the data is stale.

Plus golden-fixture tests: a saved real response per adapter, asserted against an
expected normalized output. This is what makes `html`-rung sources tolerable at
all, and it is why the ingest package has a `test/fixtures/` directory. It also
means adapters are testable **without network access**, which matters here —
this container's egress policy currently blocks outbound HTTP, so fixtures are
the only way these parsers can be verified at all right now.

---

## 8. Bidding: what is actually possible

This needs plain language, because it determines what the paid tier can honestly
promise.

**eBay — genuinely possible, gated on paperwork.** The Offer API exposes
`placeProxyBid`. But it is a **Limited Release** API: production access requires
eBay's approval and a signed contract. So it is a business-development task, not
an engineering one.

**HiBid, Proxibid, GovDeals, Wisconsin Surplus — no public bidding API exists.**
Three options, honestly ranked:

1. **Partner / affiliate integration.** The real answer. Auction houses want
   bidders. A revenue-share that sends them qualified traffic is a conversation
   they will take.
2. **Deep-link handoff with a pre-armed alert.** We hold the lot, the user's
   ceiling and the closing time; at T-minus-whatever we push a notification with
   a one-tap link straight to that lot. Legal, no terms violated, ships now.
3. **Storing user credentials and automating their session.** Violates the terms
   of essentially every platform, gets *the user's* account banned, and moves
   liability onto us. Not worth considering.

**So the v1 paid tier does not sell bid placement.** It sells: more standing
hunts, photo-matched hunts, sub-minute alerts, and rival intelligence. Real bid
placement arrives per-platform as partnerships land. Stating this now is cheaper
than discovering it after pricing a plan around it.

---

## 9. Rival intelligence

Most platforms publicly display pseudonymous bidder labels ("Bidder 4821") and a
bid history. Stored in `bid_events`, that yields a genuinely useful behavioural
profile in `rivals`:

- `median_snipe_seconds` — how late they strike. The most actionable single number
  in the whole product.
- `win_rate`, `avg_overbid_ratio` — how far past estimate they will chase.
- `top_categories` — what they hunt.

Rendered: *"You are up against B-4821 — wins 68% of tool lots and bids in the
last 45 seconds."*

Two boundaries, held deliberately: we model the **alias**, and never attempt to
resolve it to a person. And the entitlement is enforced in the database
(`has_rival_intel()` on the RLS policy), not in the UI — a paywall that exists
only in the front end is not a paywall, because anyone with the anon key can read
the table directly.

---

## 10. Stack

| Layer | Choice | Why |
|---|---|---|
| Database | Supabase Postgres 17 | already provisioned; `pgvector` + `PostGIS` + `pg_cron` + `pgmq` all verified installed |
| Scheduler / queue | `pg_cron` + `pgmq` | nothing extra to host, which was the open question |
| Workers | Supabase Edge Functions | server-side fetch, so no CORS and no leaked keys |
| Embeddings | CLIP ViT-L/14, 768-d | fixed shared cost, ~$12/day at 20k lots/day |
| Web | Vite + React, PWA | installable on a phone, one codebase for web and mobile |
| Native | React Native later, same API | only once the API has stabilised |
| Hosting | Vercel | already connected, `waystock.org` already attached |

**PWA before native, deliberately.** A PWA is installable, gets push
notifications, and ships to iOS, Android and desktop from one codebase. Since the
entire value is *"tell me the moment this appears,"* push is the only native
capability that actually matters, and a PWA has it. Build native when the App
Store presence is itself worth something — not before.

---

## 11. Build order

Each step is independently useful, which is the test of whether an order is real.

1. **Schema + extensions.** Done and applied.
2. **`postal_codes` seeded for Wisconsin.** Unlocks all radius search.
3. **GSA adapter.** Rung 1, key in hand, real federal lots in the database.
4. **HiBid platform adapter.** The single highest-leverage piece of code in the
   project — hundreds of Wisconsin houses behind one parser.
5. **Adaptive scheduler live.** The crawler is now self-updating; the product
   exists.
6. **Search UI + zip filter.** First thing a stranger can use.
7. **Hunts + alerts.** First thing worth paying for.
8. **CLIP embedding pipeline.** The differentiator.
9. **Image hunts.** The reason to switch from a competitor.
10. **Rival intel.** Retention.
11. **Partner/affiliate bidding.** Per platform, as deals land.
