# Source inventory

Every auction source worth indexing, with the ingestion rung it belongs on.

**On verification.** This container's network egress policy blocks outbound HTTP,
so nothing here could be fetched directly. Entries are marked:

- **[V]** — URL and structure confirmed from live search results this session
- **[K]** — known platform, URL not independently confirmed here; verify first
- **[?]** — believed to exist; needs a human to check before it goes in the crawler

Nothing goes live on **[K]** or **[?]** without a `robots.txt` check and one
successful fixture capture. That is the rule, and `sources.verified` enforces it.

---

## Tier 1 — Federal

The best starting corpus: nationwide, genuinely cheap, legally clean, and the
exact "government hawks perfectly good stuff" inventory that motivates the
product.

| Source | URL | Rung | Notes |
|---|---|---|---|
| **GSA Auctions** | `gsaauctions.gov` | `official_api` | **[V]** Public GET API, JSON + XML, all participating agencies. A key already exists (`GSA_API_KEY`). **Build this first.** |
| GovDeals | `govdeals.com` | `internal_json` | **[V]** Also carries a large share of county and municipal WI sellers. High value. |
| Public Surplus | `publicsurplus.com` | `internal_json` | **[V]** Schools, municipalities, state agencies. |
| AllSurplus (Liquidity Services) | `allsurplus.com` | `internal_json` | **[K]** Industrial and fleet. |
| GovPlanet | `govplanet.com` | `internal_json` | **[K]** Ex-military vehicles and equipment. |
| US Marshals asset forfeiture | `usmarshals.gov/assets` | `html` | **[K]** Low volume, high interest. |
| Treasury seized property | `treasury.gov` | `html` | **[?]** Program has moved before; confirm current host. |
| HUD Home Store | `hudhomestore.gov` | `internal_json` | **[K]** Real estate only. Out of scope for v1. |
| Municibid | `municibid.com` | `internal_json` | **[V]** Private platform, government sellers. Strong in the Northeast but carries Midwest too. |

---

## Tier 2 — Wisconsin state and local

| Source | URL | Rung | Notes |
|---|---|---|---|
| **Wisconsin Surplus Online Auction** | `wisconsinsurplus.com` / `bid.wisconsinsurplus.com` | `html` | **[V]** **The single most important Wisconsin source.** Holds the State of Wisconsin online auction contract since 2003; also runs sales for hundreds of WI counties, municipalities, schools and sheriffs. Based in Mount Horeb. Also covers IL, MI, IA, MN. |
| Waupaca County Sheriff | via Wisconsin Surplus | — | **[V]** Confirmed live auctions on that platform. |
| Oconto County Sheriff | via Wisconsin Surplus | — | **[V]** Same. |
| UW–Madison SWAP | `swap.wisc.edu` | `html` | **[?]** University surplus; verify the current bidding host. |
| WI DOA / DNR / DOT surplus | various | — | **[?]** Largely routed through Wisconsin Surplus. Confirm rather than duplicating. |
| City of Janesville surplus | `janesvillewi.gov` | `deeplink_only` | **[V]** Publishes a pointer page to its auction host rather than lots. Index the pointer, not the page. |

### A technical warning specific to Wisconsin Surplus

Auction IDs on `bid.wisconsinsurplus.com` are opaque, URL-encoded, encrypted
query parameters:

```
/Public/Auction/AuctionDetails?AuctionId=wTEQql9u1r8eDoI02hWnbw%3D%3D
```

That is an ASP.NET application with tokenised IDs. Two consequences:

1. **You cannot construct lot URLs.** You must crawl the listing index and follow
   links. Any adapter that tries to enumerate IDs will fail.
2. **The tokens may not be stable across sessions.** If they are session-scoped,
   `external_id` must be derived from stable content (auction number such as
   `#25-832`, plus lot number) rather than from the URL. Otherwise every crawl
   creates duplicate rows instead of updating existing ones.

Determine which before writing the adapter. It changes the primary key strategy.

---

## Tier 3 — Platforms (the high-leverage layer)

Adapters here are written **once per platform** and then serve every auction house
that runs on it. This is where nearly all the engineering leverage is.

| Platform | URL | Rung | Notes |
|---|---|---|---|
| **HiBid / AuctionFlex** | `hibid.com`, `hibid.com/wisconsin`, `*.hibid.com` | `json_ld` → `internal_json` | **[V]** **Highest-leverage adapter in the project.** Nearly every small and mid-size Wisconsin house is here. Each tenant gets a subdomain; some also run white-label on their own domain. Per-auctioneer RSS exists. |
| Proxibid | `proxibid.com` | `internal_json` | **[K]** Mid and large houses, equipment-heavy. |
| AuctionZip | `auctionzip.com/wi.html` | `html` | **[V]** Primarily a *directory*. Best used to **discover** auction houses to add as sources, rather than as a lot feed. |
| Invaluable | `invaluable.com` | `internal_json` | **[V]** Art, antiques, collectibles. Already an aggregator — check terms carefully. Schrager Galleries (Milwaukee) is here. |
| LiveAuctioneers | `liveauctioneers.com` | `internal_json` | **[V]** Same category. Krueger & Krueger (WI) is here. |
| BidSpotter | `bidspotter.com` | `internal_json` | **[K]** Industrial and plant. |
| EquipmentFacts / AuctionTime | `equipmentfacts.com`, `auctiontime.com` | `internal_json` | **[K]** Sandhills. Ag and construction — very relevant to Wisconsin. |
| Purple Wave | `purplewave.com` | `internal_json` | **[V]** No-reserve ag and construction, strong Midwest inventory. |
| K-BID | `k-bid.com` | `internal_json` | **[K]** Minnesota-centred, heavy upper-Midwest overlap. Directly relevant. |
| Equip-Bid | `equip-bid.com` | `internal_json` | **[K]** Midwest. |
| Nellis Auction | `nellisauction.com` | `internal_json` | **[V]** Retail returns and overstock. Has a real mobile app. |
| GoToAuction | `gotoauction.com` | `html` | **[V]** Directory. Use for discovery. |
| AuctionGuide | `auctionguide.com` | `html` | **[V]** Directory. Use for discovery. |
| BidWrangler | `bidwrangler.com` | `internal_json` | **[K]** Independents, farm and estate. |
| Auction Mobility | various tenants | `internal_json` | **[K]** Higher-end art and antiques. |
| Wavebid | various tenants | `internal_json` | **[K]** Estate and consignment. |

---

## Tier 4 — Wisconsin private auction houses

These are the small operators the user specifically wants: the ones nobody
indexes, where the sleepers actually are. Confirmed from live search:

| House | Location | Platform | Notes |
|---|---|---|---|
| Hamele Auction Service | Central WI | `hameleauctions.hibid.com` | **[V]** 30+ years. 10% online buyer's premium, +3.5% on cards — note the premium; it belongs in `buyer_premium_pct`. |
| Beloit Auction & Realty | Beloit, **WI** | `bids.beloitauction.com` | **[V]** 50+ years, southern WI and northern IL. White-label platform on a custom domain. |
| Wisconsin Auction Company | WI | `auctionwi.hibid.com` | **[V]** |
| Schrager Auction Galleries | Milwaukee, WI | via Invaluable | **[V]** 2915 N Sherman Blvd. |
| Krueger Real Estate Auction Service | Montello, WI | via AuctionZip | **[V]** |
| Krueger & Krueger LLC | WI | via LiveAuctioneers | **[V]** |
| Hansen Auction Group | WI | `hansenauctiongroup.com` | **[V]** Equipment, farm, business, real estate. |

### The data-quality trap this list already exposed

`hansenonlineauction.hibid.com` is **Hansen Auction & Realty of Beloit, KANSAS.**
`hansenauctiongroup.com` is a **Wisconsin** operation. Similar name, and there is
a Beloit in each state.

This is exactly the failure mode that poisons a location filter: a naive crawler
matching on `"Beloit"` or `"Hansen"` places Kansas lots in Wisconsin results, and
the user drives 600 miles or, more likely, stops trusting the app.

Three mitigations, all cheap:

1. **Never infer state from a city name.** Require an explicit state, or geocode
   the full address and take the state from the geocoder.
2. **Treat ambiguous city names as unresolved**, not as best-guess. `pickup_geom`
   null is honest; `pickup_geom` wrong is corrosive.
3. **Flag any lot whose derived state disagrees with its source's declared
   `states[]`** for human review rather than silently publishing it.

---

## Tier 5 — Estate sales

Mostly *not* auctions — many are fixed-price, walk-in, first-come. Model them as
events with items rather than lots with bids. Genuinely wanted by the same user.

| Source | URL | Rung | Notes |
|---|---|---|---|
| EstateSales.net | `estatesales.net` | `internal_json` | **[V]** The category leader. Has an app, and its map/radius feature is well reviewed — study it. |
| EstateSales.org | `estatesales.org/estate-sales/wi` | `html` | **[V]** WI listings confirmed. |
| EstateSale.com | `estatesale.com` | `html` | **[V]** |
| MaxSold | `maxsold.com` | `internal_json` | **[K]** Genuine online bidding, not fixed price. |
| CTBids | `ctbids.com` | `internal_json` | **[K]** Caring Transitions franchises. |
| EBTH | `ebth.com` | `internal_json` | **[K]** Higher-end. |
| AuctionNinja | `auctionninja.com` | `internal_json` | **[K]** Estate and consignment. |

---

## Tier 6 — Marketplaces

| Source | Rung | Notes |
|---|---|---|
| **eBay** | `official_api` | **[V]** Browse API for search. A production keyset exists but **is disabled and must be enabled.** `placeProxyBid` exists via the Offer API but is Limited Release — approval and a contract required. |
| Facebook Marketplace | `deeplink_only` | **[V]** No public API. Scraping breaches its terms and is actively defended. **Store a search-URL template and hand off with a tap.** Do not ingest. |
| Craigslist | `deeplink_only` | **[K]** Same posture. |

---

## Tier 7 — Coin and collectible specialists

Listed separately because they are the proving ground for image search: high
value, dense photography, and frequent under-cataloguing in bulk lots.

| Source | URL | Rung | Notes |
|---|---|---|---|
| Heritage Auctions | `ha.com` | `internal_json` | **[K]** Largest collectibles house. Excellent photography — ideal embedding corpus. |
| Stack's Bowers | `stacksbowers.com` | `internal_json` | **[K]** Coins. |
| GreatCollections | `greatcollections.com` | `internal_json` | **[K]** Coins, high volume, weekly. |
| David Lawrence Rare Coins | `davidlawrence.com` | `internal_json` | **[K]** |

The real coin opportunity is **not** these houses — they catalogue meticulously and
their lots are efficiently priced. It is the *general* estate and municipal
auctions in Tiers 2–4, where "lot of assorted coins" hides varieties nobody
recorded. Use the specialists as the **reference corpus** to embed against, and
hunt in the general auctions.

That is the whole strategy in one sentence: **learn what things look like from the
experts, then go find those things where the experts are not looking.**

---

## Tier 8 — Wholesale and liquidation

Explicitly parked per instruction — pin, not scope. Schema supports it via
`source_tier = 'wholesale'`.

`bstock.com`, `liquidation.com`, `bulq.com`, `directliquidation.com` — all **[K]**.

---

## Existing aggregator competition

Worth knowing before positioning. None of these do what is proposed here.

| Competitor | Scope | Gap we exploit |
|---|---|---|
| **Barnebys** | **[V]** Art/antiques/collectibles, global. Aggregates thousands of houses; large realized-price archive. | Category-limited. No government surplus, no local/municipal, no radius search, no standing hunts, no visual search. |
| **Invaluable** | **[V]** Art/antiques, live bidding aggregator. | Same category limits. Is a *platform*, so has no incentive to index competitors. |
| **BidProwl** | **[V]** Government auction sites, ranked by fee. | Government only. A guide and directory, not a live monitored catalogue. |
| **GovAuctions.app** | **[V]** Aggregates GSA, GovDeals, Public Surplus, Purple Wave, GovPlanet, Municibid; has a Wisconsin page. | **The closest existing competitor.** Government only — no private houses, no estate sales, no eBay. No standing hunts, no image search, no rival intel. |
| LotSearch, The Saleroom, EasyLive | **[K]** Mostly European, art/antiques. | Not US-local. |

**The uncontested position:** nobody aggregates *federal + state + county +
private + estate* in one place, filtered by real driving distance, with standing
hunts and visual search. The government-only aggregators prove the demand and
have already done the easy half.

---

## Recommended build sequence

Ranked by (lots delivered) ÷ (engineering cost):

1. **GSA Auctions** — documented API, key in hand, national inventory. Days.
2. **HiBid platform adapter** — unlocks most Wisconsin private houses at once.
3. **Wisconsin Surplus** — the state's most important single source, but needs the
   `external_id` question answered first.
4. **GovDeals + Public Surplus** — county and municipal depth.
5. **eBay Browse** — enable the dormant production keyset.
6. **AuctionZip + GoToAuction as discovery crawlers** — not for lots, but to
   enumerate Wisconsin auction houses to add as sources. Turns source-building
   from manual research into a pipeline.
7. **Estate sale directories.**
8. **Coin specialists** — as the image-search reference corpus.
