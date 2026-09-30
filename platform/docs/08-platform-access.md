# Platform access: lawful ingestion, platform by platform

Research date: **2026-09-27**. Scope: the twenty platforms Skeuos needs for
Wisconsin coverage, assessed against the ingestion ladder in
`00-architecture.md` §2 and the legal line in `03-legal-and-tos.md`:

> Public, non-access-controlled data is fair game. Anything behind a login or an
> explicit technical block is not. We never log in to scrape, never bypass bot
> protection, and honor robots.txt.

Ladder numbering used throughout (matches the `ingest_method` enum):
**1** `official_api` · **2** `json_ld` · **3** `internal_json` (incl. GraphQL) ·
**4** `rss` / `sitemap` · **5** `html` · **6** `headless` · **7** `deeplink_only`.

---

## 0. Verification status: read this before trusting any row

**Nothing in this document was fetched live from a target platform.**

- **Direct access was impossible.** This research session's network egress
  policy denied every target host. One `robots.txt` request per host was
  attempted with an honest User-Agent (`PaddleUp-research/0.1 (manual
  robots.txt and ToS review; low volume)`), through curl for every host and
  also through WebFetch for hibid.com.
  Every attempt was refused by the session's *own* egress proxy (HTTP 403 on
  `CONNECT`, logged as `connect_rejected`) before any byte reached an auction
  site. `www.google.com` was refused the same way, so this is an allowlist on
  our side, **not** a block by the sites. We therefore never saw a challenge
  page ourselves. The attempted URLs are listed in §8.A.
- **Web search ran out.** The session-wide WebSearch budget (200 calls, shared
  with other agents) was exhausted after 11 successful queries for this task.
  Those results are tagged **[IDX]**.
- **What was used instead:** GitHub code search over public repositories
  (third-party scrapers, source audits, and one repository owned by Municibid
  itself), the Supabase documentation search tool, and Skeuos's own earlier
  research in `04-universal-extraction.md`.

Consequences:

1. Every robots.txt verdict is **NOT RETRIEVED** unless a third party recorded
   the rules; the three that were recorded are quoted as such.
2. ToS text is quoted only where a search index or a third-party audit
   captured it, and each quote says which.
3. `sources.robots_allows` stays `null` (which already means "do not crawl")
   for every source until §6 has been run **from a Supabase Edge Function**,
   the real production vantage point.

Evidence tags:

| Tag | Meaning | Trust |
|---|---|---|
| **[OFF]** | First-party: the platform's own repository or vendor documentation | High |
| **[3P, date]** | A third party's recorded observation in public code or docs, with their date where given | Medium: real observations, but their vantage point and client, not ours |
| **[IDX]** | Web-search index rendering of a page; wording may be paraphrased | Medium-low for exact wording |
| **[PRIOR]** | Skeuos's earlier research (`04-universal-extraction.md`), not re-verified | Medium |
| **UNVERIFIED** | Not established by any source this session | None |

Bracketed IDs such as [G12] or [O6] resolve to URLs in §8.

---

## 1. The finding that changes the plan

The platforms with the most Wisconsin inventory sit behind bot managers that
refuse non-browser TLS fingerprints and datacenter IP addresses:

| Platform | Evidence of a technical block |
|---|---|
| HiBid (all tenants) | Cloudflare TLS fingerprinting; plain HTTP clients get 403 since 2026-07-02; Turnstile challenge shells served with HTTP 200 [G2, G4, G6, G18] |
| GovDeals / AllSurplus | Akamai returns "Access Denied" 403 to non-browser TLS on both the site and its JSON API (2026-08-20, 2026-09-10) [G20, G21, G22] |
| Proxibid | Cloudflare; plain clients 403; blocked from EU datacenter IPs on 2026-09-07 [G3, G9] |
| BidSpotter | Blocked from EU datacenter IPs on 2026-09-07 [G9] |
| AuctionZip | 403 to curl; PerimeterX sensor path listed in filter lists [G43, G44, G45] |
| CWS Marketing (Treasury lots) | CloudFront/AWS WAF: 202 challenge to CI runners, 403 to headless browsers [G84, G85, G86] |
| IRS Auctions | Akamai edge; a 2026 sweep reported 403 [G35, G92] |

A Supabase Edge Function is exactly the client these rules refuse: a
datacenter IP with a non-browser TLS fingerprint. **This is almost certainly
why the previous attempt kept getting blocked.** The public projects that
still reach these sites do it with Chrome TLS impersonation (`curl_cffi`),
Playwright-minted clearance cookies, residential IPs, or copied login tokens
[G2, G4, G5, G10, G24]. Under Skeuos's rule each of those is bypassing bot
protection. HiBid's terms also forbid bypassing its "robot exclusion headers"
and aggregating its data (§3.1).

So the answer is not a better scraper:

1. **HiBid leaves build position 2.** It becomes deep-link now and a
   partnership target. That is the largest Wisconsin coverage gap in this
   document: HiBid's own Wisconsin company search lists 77 auction companies
   (`07-wisconsin-sources.md`, from search results).
2. **Near-term Wisconsin coverage** comes from sanctioned interfaces (eBay
   Browse, Municibid's official MCP server, the licensed aggregators BidProwl
   and GovAuctions.app) and from public sources with no observed block
   (Wisconsin Surplus on Maxanet, K-BID, Public Surplus, Purple Wave, and the
   federal event pages), each after the §6 checks and a human `ingest_allowed`
   decision.
3. **Start the partnership track now** (HiBid/Auction Flex, Liquidity Services,
   ATG, EstateSales.NET and .org), because the lead time is the constraint, not
   the code.

### Pacing across tools (0024)

Three things contact source hosts: the crawl workers, the hourly probe, and
`inspect-page` (the adapter-development tool). The workers' gate paces each run
itself. Since 2026-09-30 the probe and `inspect-page` also share one record per
host in the database (`private.crawl_hosts`):

- **Turns.** Before every request to a host, each tool takes that host's turn
  (`crawl_host_turn`). A turn is granted only when the gap since the host's last
  request is at least max(floor, Crawl-delay): the floor is 5 s for
  `inspect-page` and 1 s for the probe. A tool waits at most 20 s for a turn; a
  longer wait means the request is not made this time. The probe then keeps the
  host's previous verdict, and `inspect-page` answers 429 with `Retry-After`.
- **robots.txt cache.** Definitive answers (2xx rules, or 4xx meaning "none")
  are cached: 6 h for the probe, 1 h for `inspect-page` (RFC 9309 allows up to
  24 h). A bot manager's answer, a 5xx, a 429 or a network error is never cached,
  and is fetched again, on a turn.

This closed a real lapse: shopgoodwill.com asks for `Crawl-delay: 120`, and on
2026-09-30 both tools had fetched its home page moments after its robots.txt.

### What counts as "bypass" (policy for the fetcher and for code review)

Any of the following, used to get content a site refused our honest client, is
prohibited:

- Impersonating a browser TLS/JA3/HTTP-2 fingerprint (for example `curl_cffi`
  `impersonate=`).
- Sending a browser User-Agent to get a different answer than our honest UA
  gets.
- Driving a headless or headed browser, including the existing Browserless
  token, to obtain clearance cookies (`cf_clearance`, `_abck`, `_px*`,
  `aws-waf-token`) or to render pages a bot rule refuses.
- Rotating residential or mobile proxies to escape IP-reputation blocks.
- Solving or outsourcing CAPTCHA or Turnstile challenges.
- Logging in, or reusing a person's session or bearer token.
- Using hosts meant for search engines or internal use (for example the
  `prod-seo.govdeals.com` host seen in the search index [I15]) to avoid the
  protected host.

A 403, 429 or challenge response is the site's answer, and HTTP 200 with a
challenge body counts the same [G18]. Record it, set `robots_allows=false` or
`ingest_allowed=false`, and route the source to `deeplink_only`.

This is **not** bypass: a static-IP egress proxy that a partner has agreed to
allowlist. Supabase's own guidance recommends that pattern because Edge
Functions have no stable egress IPs [O3]. It is legitimate because the site
has authorized it.

---

## 1a. Terms of use as read on 2026-09-30

The table below was first written from a search index. On 2026-09-30 the terms
of the five sources then live in production were read directly, through
`inspect_url` as WaystockBot (every page answered 200; none was refused). The
rule applied is the one this document already applies to HiBid: **terms that
expressly forbid automated collection make a source RED until the operator
gives written permission or the owner decides otherwise.** Held sources keep
`ingest_allowed = false` (migrations 0019, 0020) and stay available as deep
links.

| Source | Terms read | Verdict | Clause (verbatim) |
|---|---|---|---|
| Public Surplus | Buyer Agreement, `/sms/all,wi/login/plainTermsAndConditions` (undated) | **PROHIBITS** (RED, held) | §1.5(v): "You will not use any robot, spider, other automatic device, or manual process to monitor or copy our web pages or the content contained herein without our prior express written permission". Acceptance is tied to registering, but the agreement also says "IF YOU DO NOT AGREE TO ACCEPT THIS AGREEMENT, YOU MAY NOT ACCESS THE SITE". |
| Wisconsin Surplus | User Agreement & Terms of Use, `wisconsinsurplus.com/terms-2/` (modified 2024-10-23) | **PROHIBITS** (RED, held) | Legal 21: "You agree that you will not use any robot, spider, other automatic device, or manual process to monitor or copy the Site or the content contained herein without Wisconsin Surplus' prior, express written permission." Legal 1: "BY ACCESSING THIS SITE, YOU, THE BIDDER, AGREE". |
| Municibid | Terms of Use, `info.municibid.com/terms` (updated 05/04/26) | **PROHIBITS** (RED, held) | §c prohibits "Accessing or attempting to access the Website through automated means" and "Scraping, reproducing, republishing, selling, reselling, duplicating, or trading the Website or its content". The MCP connector is "for discovery and research only" and is not carved out; the only route named is "a separate written agreement". |
| PropertyRoom | User Agreement (Freshdesk articles, 2019-09-27; Conduct of Users 2020-06-24) | **AMBIGUOUS** (on) | No clause on automated access. Conduct of Users: "nor will you redeliver any content using framing, hyperlinks, or other technology without PropertyRoom.com's express written permission". A public app should link out, not show their photos. |
| Hansen Auction Group (BidWrangler) | Per-auction Terms (undated); no site-wide page; BidWrangler's platform terms not retrievable | **AMBIGUOUS** (on) | No clause on automated access. "Media used on Hansen Auction Group's bidding platform or marketing platforms cannot be used by customers." |

The second wave, read the same day (0022):

| Source | Terms read | Verdict | Clause (verbatim) |
|---|---|---|---|
| BidSpotter (Proxibid Inc, DBA BidSpotter) | Website Terms and Conditions (2024-06-24) | **PROHIBITS** (held) | §4.2: the user agrees not to "use any data mining, robots or similar data gathering or extraction methods". §9 restricts even linking without consent, except "for the purposes of operating and providing a bona fide search engine". |
| Purple Wave | Terms of Website Use (2025-05-15) | **PROHIBITS** (held) | "Use any robot, spider or other automatic device, process or means to access the Website for any purpose, including monitoring or copying any of the material on the Website." Read through the site's own `?_escaped_fragment_=` snapshot, which it advertises to crawlers. robots.txt now disallows `/auction/results*` (§3.9 said it did not). |
| ShopGoodwill | Terms of Use (2025-01-22) | **PROHIBITS** (held) | §6: "use any robot, spider, crawler, scraper, script, browser extension, offline reader or other automated means or interface not authorized by us to access the Services, extract data". robots.txt sets `Crawl-delay: 120`. |
| LiveAuctioneers | Terms and Conditions (2025-03-26) | **PROHIBITS** (held) | §8: "You agree that you will not use any robot, spider, scraper, or other automated means to access the sites for any purpose without our express written permission." |
| Invaluable (and Schrager, which sells there) | Terms of Use v3.11 (2019-11-05) | **PROHIBITS** (held) | §5.2: "you will not use any robot, spider, other automatic device, or manual process to monitor or copy our web pages or the content contained herein without our prior expressed written permission." |
| K-BID | Not retrievable | Blocked | robots.txt and the home page answer HTTP 403 (awselb) to our crawler. |
| AuctionGuide | None published (`/terms/` is 404) | **PERMITS search use** (live) | robots.txt: "As a condition of accessing this website, you agree to abide by the following content signals": `search=yes, ai-train=no, use=reference`. Search means a search index returning hyperlinks and short excerpts; `/search/` and `/calendar/` are disallowed. Built as sale-level rows (0023): one row per sale, a short excerpt with street addresses and phone numbers removed, a link to the sale. Live for Wisconsin and its four neighbours (0027). |

The third wave, read the same day with inspect-page's `find` option, which
returns every passage matching a pattern in one request (0028). These were the
registered sources still marked permitted whose terms no one had read
first-hand:

| Source | Terms read | Verdict | Clause (verbatim) |
|---|---|---|---|
| EstateSales.NET (Vintage Software, LLC) | Terms of Service (effective 2025-10-01), `/terms-of-service` | **PROHIBITS** (held) | Expressly prohibited: "using or attempting to use any engine, software, tool, agent, or other device or mechanism (including without limitation browsers, spiders, robots, avatars, or intelligent agents) to harvest or otherwise collect information from the Service for any use". |
| IronPlanet (RB Group) | Terms and Conditions, `/pop/terms_page.jsp` | **PROHIBITS** (held) | §1.3(c): you will not "use any robot, spider, scraper, data mining tool, data gathering or extraction tool, or any other automated means to access, collect, copy, or record the Services". Ritchie Bros and GovPlanet are RB Group too, and already refuse our crawler (Akamai 403, AWS WAF CAPTCHA); they are held on the same terms. |
| EstateSales.org | Not readable by a crawler | Held as a precaution | robots.txt disallows `/terms` and `/privacy` for every user agent, so our tools do not read them. A third-party audit [G52] quotes §4.1 barring scraping, with liquidated damages of $0.25 a page and $3,000 a day for aggregation. Read them in a browser before any request for permission. |
| Proxibid | Unified User Agreement and Data Use Agreement, both PDFs (`/docs/ProxibidUUA.pdf`) | Held as a precaution | The agreements are published only as PDFs, which inspect-page does not read. The same company's BidSpotter terms forbid "any data mining, robots or similar data gathering or extraction methods" (second wave). |

While a source is held, the hourly probe reads only its robots.txt, which sites
publish for crawlers to read, and does not fetch its pages: several of these
terms forbid automated access "for any purpose". The source keeps the access
verdict of its last full probe.

What this means for Wisconsin coverage: of the platforms carrying most
Wisconsin public-sector inventory, every one read so far (HiBid, Public
Surplus, Wisconsin Surplus, Municibid, and GovDeals behind Akamai) is closed to
an unpermitted crawler. The route is the one section 1 names: written
permission or a feed from each operator. Wisconsin Surplus in particular
describes itself as the State of Wisconsin DOA's contracted auction vendor, so
a request that cites public-sector transparency has a reasonable chance.

## 2. Summary table

Postures: **GREEN** (sanctioned or public-domain, no block) · **YELLOW**
(public and unauthenticated, no block seen, but terms unknown or a
session-token gate: needs human sign-off) · **RED** (technical block against
our client class and/or terms that prohibit our use: deep-link or partner
only).

| Platform | Best rung now | Endpoint pattern | robots verdict | ToS verdict | Bot protection | Recommendation |
|---|---|---|---|---|---|---|
| **HiBid** (+ `*.hibid.com`, white-label) | 7 (partner feed later) | `POST https://{host}/graphql` (Apollo, op `LotSearch`); lots `/lot/{id}` | NOT RETRIEVED | Forbids automated collection **and** "aggregating data or content" [IDX] | Cloudflare TLS fingerprinting; Turnstile [3P] | **RED.** Deep-link; HiBid/Auction Flex partnership; auctioneer opt-in exports |
| **K-BID** | 5 `html` | `/auction/list`, `/auction/{id}`, `/auction/{id}/item/{n}` | NOT RETRIEVED | NOT RETRIEVED | None observed; plain `requests` works [3P] | **YELLOW.** Build after robots/ToS check; ask about affiliate feed |
| **GovDeals** | 7 (licensed data via aggregator or partner) | `POST https://maestro.lqdt1.com/search/list`, `businessId:"GD"` | NOT RETRIEVED | User Agreement not retrievable (SPA) | Akamai 403 to non-browser TLS [3P] | **RED** direct. License via BidProwl/GovAuctions or a Liquidity Services deal |
| **AllSurplus** | 7 | same API, `businessId:"AD"` | NOT RETRIEVED | not retrievable (SPA) | 403 to plain HTTP [3P] | **RED.** Low Wisconsin value |
| **Public Surplus** | 5 `html` (4 if RSS exists) | `/sms/{org},{st}/list/current?orgid=`, `/sms/{org},{st}/auction/view?auc=` | NOT RETRIEVED | NOT RETRIEVED | None observed; 200 to plain HTTP; JS grid [3P] | **YELLOW.** Probe RSS and list pages; sign-off |
| **Municibid** | 1 (official MCP) | `POST https://ai.municibid.com/mcp` → `search_auctions` | NOT RETRIEVED (MCP needs none) | Official read-only rules published [OFF]; site terms not retrieved | MCP unauthenticated [OFF]; HTML reports conflict [3P] | **GREEN** pending a terms check. First wave |
| **Proxibid** | 7 | `/_next/data/{buildId}/…json` → `pageProps.lotItems` | NOT RETRIEVED | NOT RETRIEVED | Cloudflare; blocked from datacenter IPs [3P] | **RED.** ATG partnership |
| **AuctionZip** | 7 (manual discovery only) | `/cgi-bin/auctionsearch.cgi?zip=&category=` | NOT RETRIEVED | NOT RETRIEVED | 403 to curl; PerimeterX signal [3P] | **RED.** People use it to find houses to add; no crawler |
| **BidSpotter** | 7 | `/en-us/auction-catalogues/{house}/catalogue-id-{id}/lot-{uuid}` | NOT RETRIEVED | NOT RETRIEVED | Blocked from datacenter IPs [3P] | **RED.** ATG partnership |
| **Purple Wave** | 5 `html` (2 if JSON-LD) | `/auction/{yymmdd}/item/{id}`; `/search?search[keyword]=` | `Disallow` `/auction/*/bids` and `*filters=` [3P, 2026-08-11] | NOT RETRIEVED | None found | **YELLOW.** Avoid `filters=` URLs; ask about syndication |
| **EstateSales.NET** | 7 | `/api/sale-details?bypass=…`; city pages carry Event JSON-LD | Listing/detail allowed; `/api/user-view-details`, `/v2`, `/v3`, `/legacy`, `/account`, `/homepages` disallowed [3P] | §16.6 bars harvesting without written permission [3P] | Not observed [3P] | **RED.** Ask for written permission |
| **EstateSales.org** | 7 | `/estate-sales/{st}/{city}/{zip}/{slug}-{id}` (embedded sale JSON) | robots.txt 301-redirects [3P] | §4.1 bars scraping; **liquidated damages** $0.25/page, $3,000/day for aggregation [3P] | None observed | **RED.** Authorized API only |
| **MaxSold** | 3 `internal_json` | `GET https://api.maxsold.com/sales/search?lat=&lng=&radiusMetres=…` | NOT RETRIEVED | NOT RETRIEVED | None found | **YELLOW.** Confirm Wisconsin presence and ToS first |
| **AuctionNinja** | 7 | `/auctions` (JS-rendered) | NOT RETRIEVED | NOT RETRIEVED | JS rendering only | **YELLOW** legally; deep-link in practice (tiny WI footprint) |
| **Wisconsin Surplus** (Maxanet) | 5 `html` (the site's own XHR fragments) | `GET /Public/Auction/GetAuctions?filter=Current&pageSize=1000`, `GetAuctionItems?aucId=` | NOT RETRIEVED | NOT RETRIEVED | None observed; anonymous session cookie required [3P] | **YELLOW.** Most important WI source: ask Wisconsin Surplus for permission or a feed; build the Maxanet adapter |
| **BidProwl** | 1 (licensed API/MCP) | REST API + MCP (paths UNVERIFIED) | n/a | API sanctioned; scraping BidProwl forbidden [PRIOR] | API key | **GREEN** for the API; confirm redistribution rights |
| **GovAuctions.app** | 1 (API/MCP) + CC-BY dataset | `https://govauctions.app/api/mcp`; Data API | n/a | Terms not retrieved | MCP listed with an open-lock (no-auth) icon [3P] | **GREEN** pending terms; WI coverage audit |
| **US Treasury** | 5 `html` (sale level) | `/auctions/treasury/gp/`, `/auctions/treasury/rp/`; lots on `bid.cwsmarketing.com` | NOT RETRIEVED | Federal works; CWS terms not retrieved | treasury.gov: none (plain HTTP works from CI); CWS: AWS WAF [3P] | **GREEN** for sale pages; deep-link CWS lots |
| **US Marshals** | 4 sitemap + 5 (sale level) | `/what-we-do/asset-forfeiture`, `/real-property`; contractor sites | NOT RETRIEVED; sitemap exists [3P] | Federal works; contractor terms vary | One 2026 sweep: 403 [3P] | **GREEN** if reachable; low volume |
| **IRS Auctions** | 4 sitemap + 5 | `https://www.irsauctions.gov/ad/{slug}` | NOT RETRIEVED; sitemap lists `/ad/` pages [3P] | Federal site; terms not retrieved | Akamai edge; 403 reported [3P] | **GREEN** legally, **YELLOW** technically: verify from Supabase |
| **eBay Browse API** | 1 `official_api` | `GET https://api.ebay.com/buy/browse/v1/item_summary/search` | n/a | License: at most 6 h stale on display; no bulk redistribution; no AI training [3P] | OAuth; 5,000 calls/day default | **GREEN.** Activate the keyset through the account-deletion endpoint |

---

## 3. Platform detail

Each section follows the brief's items: **a** robots.txt · **b** sitemaps ·
**c** feeds · **d** JSON-LD · **e** internal JSON/GraphQL · **f** official API
or partner program · **g** terms · **h** bot protection · **i**
recommendation.

### 3.1 HiBid (hibid.com, `*.hibid.com` tenants, white-label domains)

HiBid is an Angular PWA. Tenant subdomains such as `hameleauctions.hibid.com`
and white-label domains such as `bids.beloitauction.com` are the same
application, so one adapter or one partnership covers them all.

- **a) robots.txt.** NOT RETRIEVED. `https://hibid.com/robots.txt` was
  attempted (curl and WebFetch) and denied by this session's egress, and no
  public copy was found. Crawl-delay and Sitemap lines are unknown. Note that
  HiBid's terms make its "robot exclusion headers" contractually binding
  (item g).
- **b) Sitemaps.** An HTML navigation sitemap exists at `/home/sitemap`, and
  per tenant (for example `barsbyauctions.hibid.com/home/sitemap`) [IDX I5, I6].
  Whether an XML sitemap lists lots is UNVERIFIED. Lot URL shapes seen in the
  index: `https://hibid.com/lot/316551444/{slug}`,
  `https://burgessauctions.hibid.com/lot/178812194`, and
  `https://hibid.com/www.heretn.com/lot/316337931/{slug}` [IDX I10].
- **c) Feeds.** No native RSS is confirmed. `01-sources.md` says per-auctioneer
  RSS exists, but `seed/sources.sql` already retracts that: the snippet it came
  from described third-party tools that export RSS. Treat RSS as absent until a
  live probe finds a `<link rel="alternate" type="application/rss+xml">`.
- **d) JSON-LD.** A browser extension reads a schema.org **Product** node from
  rendered lot pages (`/lot/{id}`) [G19]. Whether that node carries price and
  end time is UNVERIFIED. A server-side probe of a state category page and a
  tenant page got HTTP 200 bodies that were Cloudflare Turnstile shells, with
  zero `ld+json`, zero `ng-state` and a generic `<title>` [G18]. Some HTML
  responses also embed an Apollo cache in
  `<script id="hibid-state" type="application/json">`, with Angular's
  `&q;`-style escaping [G16, G17].
- **e) Internal GraphQL.** Documented only through public code, and not
  executed here:
  - Endpoint `POST https://hibid.com/graphql`. Tenants serve the same path on
    their own host, because the PWA builds the API URL from
    `location.hostname + "/graphql"` [G1, G4]. A `site_subdomain` request
    header scopes queries to a tenant [G15].
  - Apollo server with introspection disabled. The schema is visible only in
    the PWA bundle at
    `https://cdn.hibid.com/cdn/pwa/<version>/main.<hash>.js` [G4, G8].
  - Operations seen: `LotSearch`, `LotSearchLotOnly`, `GetLotDetails`,
    `CurrentBidsSearch` [G3, G10, G13, G14].
  - Query shape, assembled from [G4, G10, G11, G12]:
    ```graphql
    query LotSearch($auctionId: Int = null, $pageNumber: Int!, $pageLength: Int!,
                    $category: CategoryId = null, $searchText: String = null,
                    $zip: String = null, $miles: Int = null, $state: String = null,
                    $status: AuctionLotStatus = null, $sortOrder: EventItemSortOrder = null,
                    $countAsView: Boolean = true, $hideGoogle: Boolean = false) {
      lotSearch(input: {auctionId: $auctionId, category: $category, searchText: $searchText,
                        zip: $zip, miles: $miles, state: $state, status: $status,
                        sortOrder: $sortOrder, countAsView: $countAsView, hideGoogle: $hideGoogle},
                pageNumber: $pageNumber, pageLength: $pageLength) {
        pagedResults { pageLength pageNumber totalCount filteredCount
                       results { id lotNumber lead  # remaining fields UNVERIFIED
                                 lotState { highBid bidCount } } }
      }
    }
    ```
  - **Data traps** for any future partner feed on this schema. The field
    `bidAmount` returns a placeholder, `123.45`, not the current bid; one
    project saw it "on all 801 live lots checked". Read `lotState.highBid`
    together with `bidCount` instead [G1, G8, G16]. Passing `countAsView:false`
    keeps polling out of HiBid's view counters [G12].
- **f) Official API or partner program.** None public. Auction Flex, HiBid's
  software side, has a "Direct HiBid Integration" and an Integrated Web
  Service, but both carry catalogs *into* HiBid from auctioneers [IDX I9;
  PRIOR P7]. Routes: business development with HiBid/Auction Flex for a
  syndication or affiliate feed, and **auctioneer opt-in**, where Wisconsin
  houses send Skeuos their own catalog exports (auctioneers own their
  catalogs; see `04` on export formats).
- **g) Terms.** `https://hibid.com/home/termsofuse`, with identical tenant
  copies such as `farrellauctionservice.hibid.com/home/termsofuse`. The
  following is the search index's rendering and is **not fetched**, so verify
  the wording [IDX I1, I2]:
  > "any robot, spider, scraper, data mining tool, data gathering tools, data
  > extraction tools, or any other automated means to access our Sites or
  > Services, or collect, copy or record our Auction Information or content
  > off our Sites or Services"

  > "bypass any measures we may use to prevent or restrict access to our
  > Services, including our robot exclusion headers"

  The index also paraphrases a ban on "copying, downloading, distributing,
  transmitting, reusing, reporting, reproducing, modifying, using, creating
  derivative works from, or publicly displaying any Auction Information or
  content … for public or commercial purposes, including generating reports or
  **aggregating data or content**", and on imposing "an unreasonable or
  disproportionately large load". **Verdict:** this prohibits Skeuos's
  business model on HiBid data specifically.
- **h) Bot protection.**
  - "Cloudflare began 403ing plain httpx on hibid.com/graphql (observed
    2026-07-02)" [G2].
  - "HiBid is fronted by Cloudflare, which performs TLS fingerprinting in
    addition to IP / behaviour heuristics" [G4].
  - "Cloudflare blocks requests from datacenter IPs" (a build environment)
    [G6]. "Datacenter IPs were blocked before `curl_cffi`" [G7].
  - Turnstile challenge markers in HTTP 200 responses on hibid.com and on a
    tenant host [G18].
  - Counter-signal: one project recorded on 2026-09-07 that `/graphql`
    "answers unauthenticated `lotSearch` queries from EU IPs"; its client was
    not recorded [G8].
- **i) Recommendation: RED. Rung 7, `deeplink_only`.**
  - Refresh cost now: **0 requests/hour**. Construct search links such as
    `https://hibid.com/lots?q={query}`, already in the seed file, and state
    pages.
  - Reasoning: both prongs of the legal line fail. There is a technical block
    against our client class, and the terms expressly forbid automated
    collection, aggregation and bypassing exclusion headers.
  - Lawful Wisconsin coverage in the meantime: sale-level announcements from
    auctioneers' own websites (their RSS or WordPress feeds, linking out to the
    HiBid catalog), and auctioneer-supplied exports.
  - Sizing for a partner conversation: a full hourly Wisconsin sweep through
    `lotSearch` would cost `ceil(open_WI_lots / 100)` calls, roughly 200–600
    per hour if 20,000–60,000 Wisconsin lots are open (UNVERIFIED). That is why
    the ask should be a **delta feed**, not API access.

### 3.2 K-BID (k-bid.com)

- **a) robots.txt.** NOT RETRIEVED.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** None found.
- **d) JSON-LD.** UNVERIFIED.
- **e) Internal JSON.** None found in public code. Public tools parse
  server-rendered HTML with `requests` and BeautifulSoup [G32], and one notes
  that parsing "depends on K-BID markup" [G31]. URL patterns [G30, G33, G110]:
  - `https://www.k-bid.com/auction/list` (paginated browse list)
  - `/auction/{auctionId}`
  - `/auction/{auctionId}/item/{n}`
  - `/auction/search?search=submit&search_phrase_inline={q}&category_ids={id}`

  `/user/login` exists; never use it.
- **f) Official API or partner program.** No API found. Links such as
  `https://www.k-bid.com/auction/list?affiliate=481577` appear in the wild
  [G34], which suggests an affiliate program. Ask K-BID whether it comes with a
  feed.
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** None observed. Plain `requests` works [G32], and one
  browser app fetches K-BID through generic CORS proxies [G31].
- **i) Recommendation: YELLOW. Rung 5 `html`.**
  - Refresh: **20–80 requests/hour** on the adaptive ladder; a full hourly
    sweep would be 50–250. That assumes 10–40 Wisconsin auctions of 150–400
    items each (UNVERIFIED).
  - Reasoning: public and unauthenticated with no block observed. The terms
    are unknown, so a human reads them before `ingest_allowed` is set.
  - K-BID is Minnesota-centred: take the state from each lot's pickup address,
    never from a city name (`01-sources.md` data trap).

### 3.3 GovDeals and AllSurplus (Liquidity Services)

- **a) robots.txt.** NOT RETRIEVED for both.
- **b) Sitemaps.** UNVERIFIED. The search index shows a
  `prod-seo.govdeals.com/en/new-listings` host [IDX I15]. Its purpose is
  unknown, likely prerendering for search engines. Do not use it without
  GovDeals' permission (see §1, "bypass").
- **c) Feeds.** No RSS found. A "New Surplus Inventory Listings" page exists
  at `https://www.govdeals.com/en/new-listings` [IDX I14].
- **d) JSON-LD.** UNVERIFIED. GovDeals is an Angular SPA, and legacy URLs now
  return the SPA shell (70,399 bytes, no data) [G23].
- **e) Internal JSON.** Documented in public code; not executed here.
  - `POST https://maestro.lqdt1.com/search/list`. Related paths include
    `/search/seller` and `/assets/{id}/…` [G20, G25, G29, G108].
  - Headers:
    - `x-api-key` and `Ocp-Apim-Subscription-Key`, carrying anonymous
      storefront keys embedded in the public JavaScript as `maestroApiKey`.
      The values are deliberately not reproduced here.
    - `x-user-id: -1`
    - `x-api-correlation-id: <uuid>`

    Sources: [G20, G25, G26].
  - Body shape: `{"businessId":"GD","searchText":"…","isQAL":false,"auctionTypeId":null,"page":1,"displayRows":100,"sortField":"auctionEndDate",…}`.
    `displayRows` of up to 500 has been seen [G28]; the sort field is from
    [G109]. AllSurplus uses
    `businessId:"AD"` and GovPlanet `"GI"` [G27].
  - Response per lot: `assetId`, `accountId`, `assetShortDescription`,
    `locationCity/State/Zip`, `currentBid`, `assetAuctionEndDate`, plus facets
    such as `sellerDisplayName` [G21]. Detail pages live at
    `https://www.govdeals.com/asset/{assetId}/{accountId}` [G21].
  - Account-scoped endpoints such as the "bidbox" exist. They are out of
    bounds.
- **f) Official API or partner program.** No public API. A third-party audit
  classes it "official = partner", requiring a data licence [G53]. GovDeals
  data may already be available through the licensed aggregators (§3.15),
  which needs a coverage check.
- **g) Terms.**
  - GovDeals User Agreement `https://www.govdeals.com/content/site-terms`,
    registration terms `https://www.govdeals.com/register/registration/terms`,
    and seller-specific terms at
    `/content/termsandconditions/{id}?companyName=…` [IDX I11–I13].
  - AllSurplus: `https://www.allsurplus.com/account/terms-and-conditions`
    [IDX I18].
  - **Text NOT RETRIEVED.** These are client-rendered pages and the index
    returned no body.
- **h) Bot protection.**
  - Akamai: "maestro.lqdt1.com sits behind Akamai edge protection that rejects
    a non-browser TLS fingerprint before the key is ever evaluated, and returns
    an Access Denied HTML body" (2026-09-10) [G21]. See also "Akamai-walled
    unless `curl_cffi` impersonates Chrome" (last verified 2026-08-20) [G20]
    and [G22, G24].
  - AllSurplus listing pages return 403 to plain HTTP [G22].
- **i) Recommendation: RED for direct access. Rung 7 for both.**
  - Get the data as licensed rung-1 data through BidProwl or GovAuctions.app,
    or through a Liquidity Services data deal.
  - Refresh now: **0 requests/hour**. If licensed, Wisconsin would be about
    1–4 calls per sweep (UNVERIFIED).
  - Reasoning: an explicit technical block, plus an API gated on
    anonymously issued keys. Under the legal line the block alone is
    disqualifying. This supersedes `01-sources.md`'s `internal_json` rung for
    GovDeals.

### 3.4 Public Surplus (publicsurplus.com)

- **a) robots.txt.** NOT RETRIEVED.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** The brief asked specifically about RSS: **none found** in
  public code or the search index. One project warns that the government-auction
  RSS URLs it once used "were fabricated and didn't work" [G38]. On the first
  live run, look for
  `<link rel="alternate" type="application/rss+xml">` on
  `https://www.publicsurplus.com/sms/all,wi/browse/home` (pattern) and on
  agency list pages.
- **d) JSON-LD.** UNVERIFIED.
- **e) Internal JSON.** The category page
  `https://www.publicsurplus.com/sms/all,nc/browse/cataucs?catid=15` returned
  HTTP 200 (75 KB) to plain HTTP, but it is a JS grid with **zero static
  `auc=` links** [G35, G22]. The grid therefore loads from some XHR endpoint,
  which is UNVERIFIED. Identify it once by hand in browser devtools; do not
  crawl headless to find it. Server-side URL patterns:
  - Agency current-auction list: `/sms/{org},{st}/list/current?orgid={id}` [G36]
  - Auction detail: `/sms/{org},{st}/auction/view?auc={id}` [G37]
- **f) Official API or partner program.** None public. A third-party audit
  says "partnership required", but only on industry knowledge [G53].
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** None observed; HTTP 200 to plain clients [G35].
- **i) Recommendation: YELLOW.**
  - Rung 4 if an RSS feed exists. Otherwise rung 5 on agency and state list
    pages, or rung 3 if the grid's XHR endpoint is unauthenticated.
  - Refresh: **5–20 requests/hour** on the ladder (10–50 for a full sweep),
    assuming 40–120 active Wisconsin auctions (UNVERIFIED).
  - Reasoning: public and unblocked, but the terms are unknown.

### 3.5 Municibid (municibid.com)

- **a) robots.txt.** NOT RETRIEVED. The MCP route below does not depend on it,
  but check it before any HTML fetch.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** None found.
- **d) JSON-LD.** UNVERIFIED. Search pages are server-rendered: a request to
  `https://municibid.com/search/?q=real+estate&state=North+Carolina` returned
  HTTP 200 with 224 KB [G22, G35].
- **e/f) Official API: yes.** Municibid publishes a hosted MCP server from its
  own GitHub organization [OFF O4–O9]:
  - Endpoint: `https://ai.municibid.com/mcp`, Streamable HTTP, server name
    `municibid-read-only-mcp`.
  - Verbatim: "Auth: none required for these public read-only tools."
  - Verbatim: "GET on `/mcp` returns HTTP 405 (`Method not allowed`). That is
    expected. Clients must POST JSON-RPC." [O6]
  - Tools: `search_auctions` (keyword, location, price, closing window),
    `get_auction_details` (by `auction_id` or municibid.com URL),
    `get_sold_comps`, `estimate_market_value`, `get_agency_profile` [O4].
  - `search_auctions` "Returns: `results[]` with `auction_id`, `title`,
    `category`, `seller_name`, `city`, `county`, `state`, `current_price`,
    `bid_count`, `closing_at`, `image_url`, `listing_url`, plus `result_count`
    and `data_freshness`" [O6]. Bid count and close time are the two fields
    JSON-LD can never give (`00-architecture.md` §2).
  - Municibid's own probe calls
    `{"name":"search_auctions","arguments":{"query":"dump truck","state":"PA","limit":1}}`
    [O9]. Follow the normal MCP `initialize` → `tools/call` sequence.
  - Listing URLs look like `https://municibid.com/Listing/Details/{id}` [O7].
  - The same data is offered as a ChatGPT app [G40].
- **g) Terms.** The plugin rules, verbatim from Municibid's repository [O8]:
  > "Do not place bids, create listings, modify accounts, process payments, or
  > expose bidder identities or seller contact information."

  > "Send buyers to the canonical municibid.com `listing_url` from the tool
  > response to bid or complete a transaction."

  > "Display auction close times as Eastern Time (ET)."

  The site terms at `https://info.municibid.com/terms` [O11] are NOT
  RETRIEVED. Confirm whether hourly polling, storage and redisplay inside a
  third-party product are allowed: the MCP was built for AI assistants
  answering a user.
- **h) Bot protection.** The MCP is unauthenticated [O6]. For HTML, third-party
  reports conflict: one lists Municibid under Cloudflare [G39], another got
  HTTP 200 server-rendered pages [G22]. Use the MCP, not HTML.
- **i) Recommendation: GREEN, conditional on a terms check. Rung 1.**
  - Refresh: **1–5 calls/hour** for Wisconsin, plus optional
    `get_auction_details` calls for lots closing within the hour.
  - Normalize `closing_at` from Eastern Time to UTC.
  - Reasoning: a sanctioned, public, read-only interface published by the
    platform itself. Still ask Municibid for a written OK for aggregator use.

### 3.6 Proxibid (proxibid.com)

- **a) robots.txt.** NOT RETRIEVED.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** None. A per-lot `LotTimeRem` XML poll exists, but it is a
  status call, not a feed [G41].
- **d) JSON-LD.** UNVERIFIED. `__NEXT_DATA__` is the richer embedded state
  [G41].
- **e) Internal JSON.** Proxibid runs on Next.js [G41]:
  1. The category page HTML yields a `buildId` from `__NEXT_DATA__`.
  2. `GET /_next/data/{buildId}/{route}.json` returns `pageProps.lotItems` and
     `pageInfo` (`totalPages`, `current`, `size: 60` in fixtures).
  3. The `LotTimeRem` XML poll gives each lot's countdown and current bid.

  There is **no geo filter** [G42], so Wisconsin coverage would mean walking
  the whole catalog.
- **f) Official API or partner program.** No public read API. Seller ingest is
  a CSV Bulk Loader [PRIOR P8]. Partnership would be with ATG, which also owns
  BidSpotter.
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** Cloudflare: plain httpx gets 403, so `curl_cffi` is
  needed [G3]. Blocked from EU datacenter IPs, verified 2026-09-07 [G9].
- **i) Recommendation: RED. Rung 7.** Refresh: 0 requests/hour. Reasoning: a
  technical block, and no geo filter makes it inefficient even if permitted.

### 3.7 AuctionZip (auctionzip.com, Invaluable)

- **a) robots.txt.** NOT RETRIEVED.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** None found.
- **d) JSON-LD.** UNVERIFIED.
- **e) Endpoints.** It is a directory, not a lot feed [G47]:
  - `https://www.auctionzip.com/cgi-bin/auctionsearch.cgi?zip={zip}&category=0`
  - `https://www.auctionzip.com/{ST}-Auctioneers/` (for example `NY-Auctioneers`)
  - `/wi.html`, per `01-sources.md`
- **f) Official API or partner program.** Invaluable's Catalog Upload API is
  inbound only, for auction-software vendors [PRIOR P6].
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** "Returns 403 to curl; would need browser automation"
  [G43]. EasyPrivacy and Brave filter lists include
  `||auctionzip.com/eKtvxkQ2/init.js` among PerimeterX (HUMAN) first-party
  sensor paths [G44, G45]. That is a medium-confidence PerimeterX signal.
- **i) Recommendation: RED for any crawler. Rung 7.**
  - Use it only as a human research aid: people browse the Wisconsin directory
    and add houses as sources by hand.
  - Refresh: 0 requests/hour.

### 3.8 BidSpotter (bidspotter.com, ATG)

- **a) robots.txt.** NOT RETRIEVED.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** None found.
- **d) JSON-LD.** UNVERIFIED.
- **e) URL patterns** [G48]:
  - Catalogue:
    `https://www.bidspotter.com/en-us/auction-catalogues/{house-slug}/catalogue-id-{catalogueId}`
  - Lot: the catalogue URL plus `/lot-{uuid}`
- **f) Official API or partner program.** None public. Listing to BidSpotter
  from ATG's own Wavebid is a manual CSV step "repeated every time"
  [PRIOR P9]. Partnership would be with ATG.
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** Blocked from EU datacenter IPs, verified 2026-09-07
  [G9].
- **i) Recommendation: RED. Rung 7.** Refresh: 0 requests/hour. Wisconsin
  relevance is occasional industrial liquidations.

### 3.9 Purple Wave (purplewave.com)

- **a) robots.txt.** A 2026-08-11 manual check, recorded in a public
  repository, found that "actual disallows are `/auction/*/bids` and
  `*filters=`". A claimed `Disallow: /auction/results*` "does NOT exist" [G50].
  Crawl-delay and Sitemap lines are UNVERIFIED. Implications: faceted-search
  URLs containing `filters=` and bid-history pages are off-limits; auction
  results are not.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** None found. In 2012 a partner widget syndicated Purple Wave
  items onto farmprogress.com through `/cgi-bin/mnlist.cgi?{date}/{item}`
  [G51], so Purple Wave has syndicated to partners before.
- **d) JSON-LD.** UNVERIFIED. Check item pages first.
- **e) Endpoints.**
  - Keyword search:
    `https://www.purplewave.com/search?utf8=%E2%9C%93&search[keyword]={q}`
    (Rails-style; not matched by either recorded disallow, but confirm against
    the full file) [G49]
  - Sale and item pages: `/auction/{yymmdd}/` and
    `/auction/{yymmdd}/item/{itemId}` (pattern, UNVERIFIED)
- **f) Official API or partner program.** None found. Ask about a syndication
  or affiliate feed; the precedent exists.
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** None found.
- **i) Recommendation: YELLOW. Rung 5 `html`, or rung 2 if item pages carry
  JSON-LD.**
  - Discover through sale pages or a sitemap, never through `filters=` URLs.
  - Refresh: **20–100 requests/hour** on the ladder, assuming 100–400
    Wisconsin items live at a time (UNVERIFIED).
  - Reasoning: public and unblocked, with specific robots exclusions that are
    easy to honor. Terms unknown.

### 3.10 EstateSales.NET (estatesales.net, Vintage Software, LLC)

- **a) robots.txt.** A 2026 third-party audit recorded (user-agent `*`):
  "Disallows `/account /homepages /v2 /v3 /legacy /api/user-view-details`;
  listing/detail pages not disallowed; sitemap present" [G52]. A second probe
  agrees: "robots allows listing pages (blocks `/api/user-view-details`,
  `/v2`, `/v3`)" [G22].
- **b) Sitemaps.** Present [G52]; contents UNVERIFIED.
- **c) Feeds.** None found.
- **d) JSON-LD.** City hub pages (`/{ST}/{City}`) carry schema.org **Event**
  JSON-LD [G46]. A city page returns a 100-mile, multi-state radius, with the
  true locality in an embedded JSON node [G21].
- **e) Internal JSON** (public code; not executed):
  - `/api/sale-details?bypass=bycoordinatesanddistance:{lat}_{lng}_{mi}&include=…&select=id,orgName,…,saleSchedule&explicitTypes=DateTime`
  - `/api/sale-details?bypass=byidsincludinginactive:{id}&include=dates,directions,plaintextshortdescription,mainpicture`
  - `/api/search-details?filter=byCombinedSearch:{q}|highlight|byDistance:{30|50}|withOrigin:…`
  - `/api/legacy/queries/traditional-sales/traditional-sale?query={"saleId":N,…}`

  Sources: [G54–G57]. Note that `/legacy` is disallowed.
- **f) Official API or partner program.** "None disclosed" [G52].
- **g) Terms.** From the third-party audit's quotation of **§16.6** (ellipses
  are theirs) [G52]: the terms prohibit using "any engine, software, tool,
  agent … (including … browsers, spiders, robots, avatars, or intelligent
  agents) to harvest or otherwise collect information from the Service"
  without **express written permission**. They also ban storing, copying and
  redistributing content, and compiling a database.
- **h) Bot protection.** "Not observed on robots fetch" [G52]. From an EU
  datacenter the site was a JS shell (the note says "EstateSales" without
  specifying which) [G9].
- **i) Recommendation: RED. Rung 7.**
  - Deep-link to city and ZIP pages. Refresh: 0 requests/hour.
  - Reasoning: robots would allow the pages, but the terms require written
    permission for exactly this. Ask them; they are the estate-sale category
    leader and a natural partner.

### 3.11 EstateSales.org

- **a) robots.txt.** "`robots.txt` 301-redirects" [G52]. Where it redirects to
  is UNVERIFIED.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** The site sends daily email digests [G60]. Parsing them
  automatically still collects content "via … scripts" under §4.1, so they are
  not a loophole.
- **d) JSON-LD.** Server-rendered HTML "embeds full sale JSON (id, address,
  lat/lon, dates, company, in-person vs online)" [G59, G58]. Whether that is
  schema.org markup is UNVERIFIED.
- **e) URL patterns.** Sale pages follow
  `https://estatesales.org/estate-sales/{st}/{city}/{zip}/{slug}-{id}` [G61];
  the state page is `https://www.estatesales.org/estate-sales/wi`
  (`01-sources.md`).
- **f) Official API or partner program.** API access only "**unless expressly
  authorized**" [G52].
- **g) Terms.** From the audit's quotation of **§4.1** [G52]: the terms
  prohibit users to "copy, collect, scrape, harvest, or download any content …
  via robots, spiders, scripts, scrapers, crawlers, or any automated or manual
  equivalent". They cap use at "≤1,000 pages/24h" and set **liquidated damages
  of $0.25 per page for scraping and $3,000 per day for aggregation**.
- **h) Bot protection.** None observed. A research note records the site as
  "VERIFIED LIVE. Returns 200." [G43]
- **i) Recommendation: RED. Rung 7.** Refresh: 0 requests/hour. Reasoning: an
  explicit contractual ban with a damages schedule. This is the most
  financially dangerous source in the set for anyone who "just tries" it.

### 3.12 MaxSold (maxsold.com)

- **a–d)** robots.txt NOT RETRIEVED; sitemaps, feeds and JSON-LD UNVERIFIED.
- **e) Internal JSON.** The site's own public API, as used in public code;
  not executed [G62–G65]:
  - `GET https://api.maxsold.com/sales/search?lat={lat}&lng={lng}&radiusMetres={m}&country={c}&pageNumber=0&limit=24&saleState={s}&days={d}&total=true`
    The recorded example uses `country=canada&saleState=closed&days=90`. The
    value for open sales is UNVERIFIED.
  - `GET https://api.maxsold.com/sales/am/{auctionId}` (sale detail with
    location)
  - `GET https://api.maxsold.com/listings/am/{itemId}/enriched`
  - `GET https://maxsold.maxsold.com/msapi/auctions/items?auctionid={id}&itemid={itemId}`
    (items and bid history)
  - Helper: `https://api.maxsold.com/places/address?address={text}`
- **f) Official API or partner program.** None public. MaxSold is on-theme for
  estate downsizing, so partnership is plausible [G53, industry-knowledge
  rating only].
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** None found.
- **i) Recommendation: YELLOW, but first confirm that MaxSold runs Wisconsin
  sales at all.** Its evident base is Ontario; Wisconsin presence is
  UNVERIFIED.
  - Rung 3. Refresh: **5–40 requests/hour** if 2–10 Wisconsin sales are live.

### 3.13 AuctionNinja (auctionninja.com)

- **a–d)** UNVERIFIED.
- **e) Endpoints.** `https://www.auctionninja.com/auctions` is JS-rendered; a
  public project needs Puppeteer to read it [G66]. State pages:
  `/estate-sales/{state}` and `/online-estate-sales/{state}.html` [G47].
  Images come from `pictureserver.auctionninja.com`.
- **f) Official API or partner program.** None public.
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** No bot manager seen; the obstacle is JS rendering.
- **i) Recommendation: YELLOW legally, rung 7 in practice.** A headless
  browser (rung 6) is not justified for a platform concentrated in NY, NJ and
  PA with little Wisconsin inventory. Refresh: 0 requests/hour.

### 3.14 Wisconsin Surplus Online Auction (wisconsinsurplus.com, bid.wisconsinsurplus.com)

The marketing site is `wisconsinsurplus.com`; bidding happens on
`bid.wisconsinsurplus.com`, which runs **Maxanet**, an ASP.NET MVC auction SaaS.
The identification rests on its URL scheme and query tokens, which are
identical to known Maxanet tenants (ebidlocal, Prime Auctions). Those tenants
are served from `{tenant}.prod4.maxanet.auction` with images on
`s3.amazonaws.com/prod.maxanet.auction/{tenant}/…` [G67, G68, G70, G74].
Confirm on the first live run.

- **a) robots.txt.** NOT RETRIEVED for either host.
- **b) Sitemaps.** UNVERIFIED.
- **c) Feeds.** None found.
- **d) JSON-LD.** UNVERIFIED.
- **e) Internal endpoints.** Maxanet XHR endpoints, the site's own front-end
  calls, as observed across Maxanet tenants in public code; not executed:
  - `GET /Public/Auction/GetAuctions?filter=Current&pageSize=1000` with
    `X-Requested-With: XMLHttpRequest` returns an HTML fragment of current
    auction cards, each with a numeric ID in `input#hdn_AuctionId`
    [G68, G69, G70].
  - `GET /Public/Auction/GetAuctionItems?aucId={id}&pageNumber={n}&…` returns
    an HTML fragment of items [G72].
  - `GET /Public/Lookup/GetCategories` returns **JSON** [G71, G72].
  - Item detail: `/Public/Auction/AuctionItemDetail?AuctionItemId={n}&AuctionId={n}`
    [G74].
  - `POST /Public/Auction/RefreshItem` returns bid state
    (`CurrentBidAmount`). It was seen only in a logged-in context; anonymous
    behavior is UNVERIFIED [G73].
  - Constraints, per [G71]: "Maxanet API needs session cookies +
    `X-Requested-With: XMLHttpRequest`", and "Auction URLs must include all
    query params (`AuctionId`, `Title`, etc.) — Maxanet redirects to homepage
    without them."
  - What a no-login agent could extract: lot number, description, image URL,
    current bid and next minimum bid [G75].
- **The open `external_id` question in `01-sources.md` is answered, pending
  a live check.** The same token, `filter=ITUHdU2DoqWvw89vAOs0Dw%3D%3D`,
  appears on three different Maxanet tenants: Wisconsin Surplus, ebidlocal and
  Prime Auctions [G67, G70, G74]. The tokens are therefore **deterministic
  encryptions under a platform-wide key**, not session-scoped. The numeric
  auction ID is also exposed in `hdn_AuctionId` [G68].
  - `07-wisconsin-sources.md` independently corroborates this. Across the
    Wisconsin Surplus URLs it collected, the same `pageNumber`, `pagesize`,
    `filter` and `viewtypeId` tokens recur on unrelated auctions.
  - Key rows on the numeric AuctionId plus the lot number.
  - Store the token URL only as the deep link, because the redirect rule means
    it must carry every query parameter.
  - Per `07`, the platform exposes **no seller ID**: the seller is the
    auction-title prefix (`#25-1618 - Washington County Sheriff's Office - …`),
    and multi-seller sales mix sellers. Parse the seller per lot.
- **f) Official API or partner program.** None. Wisconsin Surplus
  (Mount Horeb) holds the State of Wisconsin auction contract, so a direct ask
  for permission or a feed is realistic and should happen before or alongside
  the build.
- **g) Terms.** NOT RETRIEVED.
- **h) Bot protection.** None observed. The anonymous ASP.NET session cookie
  plus XHR header is a mild gate, "an anonymously-issued token — small step up"
  in `03-legal-and-tos.md`. One public project calls Maxanet from a **Supabase
  Edge Function** [G73], evidence that Supabase egress is not blocked by
  Maxanet, at least for that tenant. That project logs in; we never will.
- **i) Recommendation: YELLOW. Rung 5**, using the HTML fragments the site's
  own front end requests. This is the highest-value Wisconsin source.
  - Refresh: **30–120 requests/hour** on the ladder. A full sweep is 1
    `GetAuctions` call plus about 1–10 `GetAuctionItems` pages per auction,
    so 50–400 requests for 20–80 active auctions (UNVERIFIED).
  - Reasoning: public and unblocked, with an anonymous session only. Get
    written permission; the Maxanet adapter then also serves other Maxanet
    tenants.

### 3.15 BidProwl (bidprowl.com), licensed aggregator

- **a–d)** Not applicable; use the API.
- **e/f) API.** Sources are [PRIOR P1] unless noted.
  - "a REST API and MCP server over every listing and sold-price stat", with a
    **free tier of 1,000 calls/month**.
  - Coverage: "46,000+ government surplus auctions from 27 sites … across all
    50 states". The homepage says 75,000+.
  - "Per-family feeds refreshed every 30 minutes but capped at 50 newest
    items."
  - It launched on Hacker News on 2026-04-30 as "I aggregated 28 US Government
    auction sites into one search" (270 points) [G76]. Commenters noted slow
    performance, **no geographic filters**, and difficult cross-site
    de-duplication [G77].
  - API paths and rate limits: UNVERIFIED, not public in anything reachable
    this session.
- **g) Terms.** The terms forbid scraping BidProwl itself; the API is the
  sanctioned path [PRIOR P2]. **Redistribution rights are UNKNOWN**, and that
  is the decisive commercial term.
- **h) Bot protection.** API key.
- **i) Recommendation: GREEN for API use within terms. Rung 1.**
  - Refresh: one Wisconsin "newest" pull per hour is about 720 calls a month,
    which fits the free tier. It cannot refresh bids across all lots.
  - Use it for discovery of GovDeals, Public Surplus and AllSurplus lots we
    cannot reach directly, and deep-link for live bids. A paid tier is needed
    for more.
  - Ask three questions: which upstream sites it covers, whether it warrants
    lawful sourcing, and whether we may redistribute the data.

### 3.16 GovAuctions.app

- **e/f) API.**
  - "A paid Data API for developers and AI agents, as well as bulk data
    licensing … as scheduled exports", with free API keys and a hosted MCP
    server [PRIOR P3].
  - A curated MCP list gives the endpoint `https://govauctions.app/api/mcp`,
    marked with an open-lock icon (read as "no authentication"; UNVERIFIED),
    with the description "Government
    surplus auctions in the US, UK, CA and AU, with sold-price comps and resale
    scores" [G79, G80].
  - A free **CC-BY 4.0** dataset of completed GSA lots, refreshed monthly, is
    mirrored at 11.7k rows [PRIOR P4, P5].
  - In April 2026 the maker described pulling from "several free government
    APIs" and ingesting state websites "rather than scraping". Commenters noted
    that **GovDeals and Public Surplus were absent** [G78].
- **g) Terms.** NOT RETRIEVED. Redistribution rights unknown.
- **i) Recommendation: GREEN pending terms. Rung 1.** Refresh: 1–5
  calls/hour (limits UNVERIFIED). Use the CC-BY dataset as the canary
  corpus, as `04` proposes. Audit Wisconsin coverage before paying.

### 3.17 US Treasury seized-property auctions

- **a–d)** robots.txt NOT RETRIEVED; sitemaps, feeds and JSON-LD UNVERIFIED.
- **e) Pages.** Sale-level pages:
  - `https://www.treasury.gov/auctions/treasury/gp/` ("General Property,
    Vehicles, Vessels & Aircraft")
  - `https://www.treasury.gov/auctions/treasury/rp/` (real estate)
  - The hub `https://home.treasury.gov/services/treasury-auctions`

  Sources: [G82, G88, G107]. CWS Marketing Group "runs most of the Treasury
  forfeiture sales and publishes its own calendar" [G83]:
  - Calendar: `https://cwsmarketing.com/auctions/upcoming-auctions/`
  - Catalogs: `https://bid.cwsmarketing.com/auctions/catalog/id/{N}?ipp=100`
  - Lots: `https://bid.cwsmarketing.com/lot-details/index/catalog/{c}/lot/{l}/{slug}`

  Sources: [G83, G84, G87]. Some Treasury vehicle sales "link there [HiBid
  catalogs] rather than to CWS" [G81], so they fall under §3.1.
- **f) Official API.** None found.
- **g) Terms.** Treasury pages are US government works, not subject to
  copyright under 17 U.S.C. §105. CWS terms are NOT RETRIEVED.
- **h) Bot protection.**
  - treasury.gov served plain HTTP to GitHub Actions runners, which are
    datacenter IPs, through 2026-09-26 [G86, G87].
  - The CWS calendar returned **HTTP 202 to CI runners**, a challenge-style
    response typical of AWS WAF [G85].
  - `bid.cwsmarketing.com` sits "behind CloudFront with a bot rule" that
    answers 403 "Request blocked" to headless Chromium [G84, G86].
- **i) Recommendation: GREEN for Treasury sale pages.**
  - Rung 5, at 2 requests/hour or every 6 hours.
  - CWS lots and calendar: **deep-link**, because a technical block applies.
  - Wisconsin volume is very low. The value is national interest in vessels,
    aircraft and real estate.

### 3.18 US Marshals Service asset forfeiture

- **a) robots.txt.** NOT RETRIEVED.
- **b) Sitemaps.** A sitemap exists: the End of Term 2024 web archive seeded
  from it, including `/what-we-do/asset-forfeiture` pages [G89].
- **c/d)** None found / UNVERIFIED.
- **e) Pages.** The hub `https://www.usmarshals.gov/what-we-do/asset-forfeiture`
  and `/what-we-do/asset-forfeiture/real-property` [G89, G90, G107]. Sales themselves
  run on contractors. A third-party audit verified Bid4Assets for "USMS
  forfeiture auctions" [G53], and a user notes that real property "uses
  reallook.com" [G91]. Each contractor has its own terms.
- **f) Official API.** None found.
- **g) Terms.** US government works; contractor terms vary and were NOT
  RETRIEVED.
- **h) Bot protection.** One 2026 sweep recorded "IRS auctions and US Marshals
  confirmed 403/dead" [G35]. Verify from Supabase.
- **i) Recommendation: GREEN legally, reachability to verify.** Rung 4
  (sitemap) plus rung 5 at sale level; deep-link to contractor catalogs.
  Refresh: **1–3 requests/day**; hourly is unnecessary.

### 3.19 IRS Auctions (irsauctions.gov)

- **a) robots.txt.** NOT RETRIEVED. `irsauctions.gov` was not attempted
  separately; the egress policy is an allowlist.
- **b) Sitemaps.** The site's sitemap lists sale pages at `/ad/{slug}`, for
  example `https://www.irsauctions.gov/ad/commercial-acreage`. This is known
  from the End of Term 2024 archive's sitemap seed list [G93].
  `/auction/items` is one of the site's most-viewed pages [G94].
- **c/d)** UNVERIFIED.
- **e) Internal JSON.** None found.
- **f) Official API.** None found.
- **g) Terms.** A federal site; content is US government work. Terms NOT
  RETRIEVED.
- **h) Bot protection.** Akamai: `www.irsauctions.gov` is a CNAME to
  `edgekey.net`, and non-production hosts answer `AkamaiGHost` "Access Denied"
  403 [G92]. A 2026 sweep reported 403 for the main site [G35].
- **i) Recommendation: GREEN legally, YELLOW technically.** Rung 4 (sitemap
  diffing) then rung 5 on changed `/ad/` pages. Refresh: **1–10
  requests/hour**. If Supabase gets a 403 or challenge, go deep-link only.

### 3.20 eBay Browse API

- **a–d)** Not applicable: an official API, not the website.
- **e/f) Official API.**
  - Endpoint: `GET https://api.ebay.com/buy/browse/v1/item_summary/search`
    [O16].
  - The method needs one of `q`, `category_ids`, `epid` or `gtin` [G101].
  - Filters include `buyingOptions`, `bidCount`, `itemEndDate`,
    `itemLocationCountry`, `pickupCountry`, `pickupPostalCode`,
    `pickupRadius`, `pickupRadiusUnit` and `deliveryOptions`
    [G100, G101, O15].
  - Verbatim from eBay's reference: "There are four filters required for local
    pickup. 'pickupPostalCode','pickupCountry','pickupRadiusUnit','pickupRadius'"
    [G102].
  - At most 200 items per page and 10,000 per result set [G101].
  - `sort=endingSoonest` works with `buyingOptions:{AUCTION}` [G103].
  - Each result carries `itemId`, `price`, `currentBidPrice`, `bidCount`,
    `itemEndDate` and the image URL [G104]. Item-location fields are in eBay's
    reference but were not verified this session.
  - Example Wisconsin query, not executed:
    ```
    GET /buy/browse/v1/item_summary/search?category_ids={id}
        &filter=buyingOptions:{AUCTION},pickupCountry:US,pickupPostalCode:53703,
                pickupRadius:100,pickupRadiusUnit:mi
        &sort=endingSoonest&limit=200
    X-EBAY-C-MARKETPLACE-ID: EBAY_US
    Authorization: Bearer <client-credentials token>
    ```
- **Eligibility and limits.**
  - Browse is "open to every registered dev" [G95].
  - The default limit is **5,000 calls per day per app** [G95, G96, G97], with
    1,000 OAuth token grants per day [G96]. The Application Growth Check raises
    limits [G98, O14].
- **Why the production keyset is disabled.** Quoting eBay's guide via [G98]
  (source: [O13]):
  > "New third-party developers coming to the platform must subscribe to or opt
  > out of eBay marketplace account deletion/closure notifications before they
  > make their first production API call. Once… subscribed… or… successfully
  > opted out, the keyset/App ID is activated."

  The endpoint contract [G98, G105]:
  - eBay sends `GET ?challenge_code=…`. Reply 200 with JSON
    `{"challengeResponse": hex(SHA-256(challengeCode + verificationToken + endpoint))}`.
  - Deletion notices arrive as POSTs. Acknowledge them with 200, 201, 202 or
    204.

  A Supabase Edge Function can host this, since it returns JSON; Supabase
  restricts only HTML responses [O1]. Alternatively, opt out if we store no
  eBay user data.
- **g) Terms.** From a third party's 2026 summary, not verbatim for the licence
  [G99]:
  - The eBay User Agreement (effective June 28, 2026) says users will not "use
    any robot, spider, scraper, data mining tools, data gathering and
    extraction tools, or other automated means" without permission. So use the
    API, never the site.
  - The API License Agreement requires displayed item listing data to be no
    more than 6 hours older than eBay's, and other content no more than 24
    hours.
  - It bars bulk electronic redistribution, selling or licensing
    Restricted-API data, and using eBay content to train AI.
  - It requires prior written consent to use Restricted APIs for pricing
    tools.
- **h) Bot protection.** Not applicable (OAuth).
- **i) Recommendation: GREEN. Rung 1.**
  - Refresh: **5–30 calls/hour** (a few category or keyword queries of 1–5
    pages each) against a budget of about 208 per hour. Our hourly refresh
    also satisfies the 6-hour display rule.
  - Before computing CLIP embeddings of eBay images (`03-legal-and-tos.md` §3),
    get counsel's view on the "no AI training" clause.

---

## 4. Hourly refresh cost and the Supabase runtime

**Model.** Requests per hour = Σ over sources of
`ceil(active_in_scope / page_size) × sweeps_per_hour`, plus detail fetches
for lots in their final hour. The adaptive closing-time ladder
(`schedule.ts`) makes most lots cost far less than one sweep an hour. The
inventory figures below are **sizing assumptions, UNVERIFIED**. Replace them
with measured counts after the first capture.

| Source | Rung | Assumed WI inventory | Full hourly sweep | With adaptive ladder |
|---|---|---|---|---|
| eBay Browse | 1 | 200–1,000 pickup auctions within 100–150 mi | 5–30 | 5–30 (budget ≈208/h) |
| Municibid MCP | 1 | 20–150 lots | 1–5 | 1–5 |
| BidProwl | 1 | n/a (50-newest feeds) | 1 | 1 (≈720/month; free tier 1,000/month) |
| GovAuctions.app | 1 | UNVERIFIED | 1–5 | 1–5 |
| Wisconsin Surplus (Maxanet) | 5 | 20–80 auctions, 2k–15k lots | 50–400 | 30–120 |
| K-BID | 5 | 10–40 auctions, 1.5k–15k items | 50–250 | 20–80 |
| Public Surplus | 4/5 | 40–120 auctions | 10–50 | 5–20 |
| Purple Wave | 5 | 100–400 items | 100–400 | 20–100 |
| MaxSold | 3 | 0–10 sales | 5–40 | 5–20 |
| Treasury | 5 | a few WI sales a year | 2 | about 0.3 (every 6 h) |
| US Marshals | 4/5 | rare | 1–3 per **day** | 1–3 per day |
| IRS | 4/5 | rare | 1–10 | 1–5 |
| All RED sources | 7 | none | 0 | 0 |
| **Total** | | | **about 230–1,200/h** | **about 90–390/h** |

On the adaptive ladder that is under 7 requests per minute across all sources
combined; even full hourly sweeps are about 20 per minute. Keep **per-host
concurrency at 1** and spacing well inside `sources.rate_limit_rpm` (default
20). The load is trivial for the sites and for us.

**Supabase Edge Function limits** [O1, O2, O3], which shape the scheduler:

- **2 s of CPU per request** (async I/O excluded), 150 s wall clock on Free and
  400 s on paid plans, 256 MB of memory.
  - Do not sweep a whole source inside one invocation.
  - Enqueue per-source jobs from `pg_cron` into Supabase Queues. A worker
    drains a bounded batch per invocation, stopping around 100 s wall and 1.5 s
    CPU.
  - Prefer JSON and HTML *fragments* (Maxanet) to full pages. Measure the CPU
    cost of HTML parsing before adding rung-5 sources in bulk.
- **No static egress IPs.** Supabase says Edge Functions "do not originate from
  a single static IP address or a small, stable range of IPs" [O3].
  - Any partner feed that needs IP allowlisting requires the documented
    static-IP egress proxy. That is legitimate because the partner authorized
    it.
  - Never use a proxy to escape a block (§1).
- **Datacenter reputation cuts both ways.** Even government endpoints can
  refuse cloud IPs: a public project records that "on GitHub Actions the CWS
  calendar returns HTTP 202 and the GSA API returns a 403 block page, while
  both are fine locally" [G85]. The existing **GSA adapter** should therefore
  be re-verified from Supabase too.

---

## 5. Recommended adapter build order for Wisconsin coverage

The order optimizes lawful Wisconsin coverage per unit of effort. It
supersedes the HiBid-first ordering in `00-architecture.md`, `01-sources.md`
and the ranking in `07-wisconsin-sources.md` (written in parallel on the same
day, from search results) for the reasons in §1. `07`'s seller inventory is
still the right input for *which* Wisconsin sellers each adapter must cover.

**Phase 0: gates (this week, no ingestion)**

0. Run the §6 verification queue from a Supabase Edge Function. Write
   `robots_url`, `robots_checked_at` and `robots_allows`, and attach the probe
   result to each `sources` row.
1. A person sets `ingest_allowed` and `ingest_note` per source from this
   document. Every RED row becomes `deeplink_only`. Retire the Browserless
   headless path for any RED host: that would be bypass.

**Phase 1: sanctioned interfaces (GREEN)**

2. **eBay Browse.** Deploy the Marketplace Account Deletion endpoint as an
   Edge Function, or opt out if no eBay user data is stored, to activate the
   production keyset. Then build the local-pickup auction search around
   Wisconsin ZIP centroids. This is the only near-term source with live bid
   counts at scale.
3. **Municibid MCP.** Wisconsin municipal and school surplus, with
   `bid_count` and `closing_at` included. Get Municibid's written OK for
   aggregator use first.
4. **BidProwl free tier and a GovAuctions.app key.** Run a coverage audit of
   what they return for Wisconsin from GovDeals, Public Surplus, AllSurplus and
   GSA, which are the government inventory we cannot reach directly. Negotiate
   redistribution rights before any production use.
5. **Federal sale pages:** Treasury `gp` and `rp`, the US Marshals hub and
   sitemap, the IRS sitemap. These are cheap, public-domain and low volume.
   Lots deep-link to contractors.

**Phase 2: public, unblocked sources (YELLOW, after sign-off)**

6. **Wisconsin Surplus through a Maxanet adapter.** This is the highest-value
   Wisconsin source. Email Wisconsin Surplus in Mount Horeb for permission or
   a feed at the same time. Key on the numeric AuctionId and lot number
   (§3.14). The adapter extends to other Maxanet tenants later.
7. **K-BID HTML adapter**, the upper-Midwest general auctions. Ask K-BID about
   its affiliate program.
8. **Public Surplus**, via RSS if the probe finds one, otherwise agency list
   pages.
9. **Purple Wave**, honoring the `*filters=` and `/auction/*/bids` exclusions;
   use JSON-LD if present.
10. **MaxSold**, only if a Wisconsin presence is confirmed.

**Phase 3: partnership track (start now, runs in parallel)**

11. **HiBid / Auction Flex.** The single biggest Wisconsin gap. Ask for a delta
    syndication feed. In the interim, recruit Wisconsin auctioneers to send
    their own catalog exports, and ingest their sale announcements from their
    own sites.
12. **Liquidity Services** (GovDeals and AllSurplus data licence), unless the
    Phase 1 aggregator audit already covers Wisconsin adequately.
13. **ATG** (Proxibid, BidSpotter).
14. **EstateSales.NET and EstateSales.org**: written permission or authorized
    API access. Until then, deep links only.

**Deep-link only until a partnership lands:** HiBid, GovDeals, AllSurplus,
Proxibid, AuctionZip (people may still use it to find houses), BidSpotter,
EstateSales.NET, EstateSales.org, AuctionNinja.

---

## 6. Verification queue: the first live run

Run **once, from a Supabase Edge Function**, with the production User-Agent
(`PaddleUpBot/{version} (+{public contact URL})`). No retries after 403, 429
or a challenge; no cookies carried between hosts; at most three requests per
host. Stop at the first blocked signal.

| Host | Requests (in order) | Pass means |
|---|---|---|
| hibid.com | `/robots.txt` only | Record status and signals. RED regardless (terms) |
| www.k-bid.com | `/robots.txt`, `/auction/list` | 200, real listing HTML, path not disallowed |
| www.govdeals.com, www.allsurplus.com | `/robots.txt` only | Record the Akamai signal. RED regardless |
| www.publicsurplus.com | `/robots.txt`, `/sms/all,wi/browse/home` | 200; look for an RSS `<link>` |
| municibid.com, ai.municibid.com | `/robots.txt`; MCP `initialize` + `tools/list` | Tool list matches §3.5 |
| www.proxibid.com, www.bidspotter.com, www.auctionzip.com | `/robots.txt` only | Record. RED regardless |
| www.purplewave.com | `/robots.txt`, one `/auction/{yymmdd}/` page | Rules match §3.9; check for JSON-LD |
| www.estatesales.net, estatesales.org | `/robots.txt` only | Record. RED (terms) |
| maxsold.com, api.maxsold.com | `/robots.txt` each | Then a *person* checks Wisconsin presence in a browser |
| www.auctionninja.com | `/robots.txt` | Record |
| www.wisconsinsurplus.com, bid.wisconsinsurplus.com | `/robots.txt` each, then the `bid.` home page | 200 and an anonymous session cookie issued |
| www.treasury.gov | `/robots.txt`, `/auctions/treasury/gp/` | 200 with a sale list |
| www.usmarshals.gov | `/robots.txt`, sitemap from robots | 200 |
| www.irsauctions.gov | `/robots.txt`, sitemap from robots | 200, not the Akamai "Access Denied" page |

**robots.txt handling.** This follows Skeuos policy, which is stricter than
RFC 9309:

- 200: parse it and honor `Disallow`, `Crawl-delay` and `Sitemap`.
- 404: allowed by convention, but a person must still sign off.
- 401, 403, 429, 5xx, a challenge, or a redirect off-site: treat as
  **blocked**, set `robots_allows=false`, and do not crawl.

Probe sketch (Deno, one GET, honest identity, no evasion):

```ts
const UA = "PaddleUpBot/0.1 (+https://REPLACE-WITH-CONTACT-URL)";
const CHALLENGE_BODY = [
  /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\//i, // Cloudflare / Turnstile
  /Access Denied[\s\S]{0,300}Reference #/i,                        // Akamai
  /captcha-delivery\.com/i,                                        // DataDome
  /px-captcha|_pxAppId|client\.px-cloud\.net/i,                    // PerimeterX / HUMAN
  /_Incapsula_Resource/i,                                          // Imperva
  /google\.com\/recaptcha|hcaptcha\.com/i,
];
export async function probe(url: string) {
  const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA } });
  const body = (await res.text()).slice(0, 300_000);
  const h = res.headers;
  const cookies = h.getSetCookie().join("; ");
  const signals = {
    status: res.status,
    server: h.get("server"),
    cfRay: h.has("cf-ray"),
    cfMitigated: h.get("cf-mitigated"),           // "challenge" on Cloudflare challenges
    awsWafAction: h.get("x-amzn-waf-action"),     // AWS WAF challenge/captcha
    datadome: h.has("x-datadome"),
    botCookies: /__cf_bm|cf_clearance|_abck|bm_sz|ak_bmsc|_px|datadome|aws-waf-token|incap_ses/i.test(cookies),
    challengeBody: CHALLENGE_BODY.some((re) => re.test(body)),
  };
  const blocked = [202, 401, 403, 429].includes(res.status) || signals.challengeBody ||
    signals.cfMitigated === "challenge" || !!signals.awsWafAction;
  return { url, blocked, signals, bytes: body.length }; // a bot cookie alone is a note, not a block
}
```

HTTP 200 with a challenge body **is blocked**; HiBid does exactly this [G18].

---

## 7. Risks

1. **HiBid is RED.** A Cloudflare block and terms that forbid aggregation
   remove the adapter the plan calls highest-leverage. Without a partnership,
   most small Wisconsin private houses are deep-link only.
2. **Datacenter blocking is the norm, not the exception.** Cloudflare, Akamai,
   PerimeterX and AWS WAF block cloud clients on private *and* federal hosts
   (IRS; the CWS calendar; GSA's API from CI [G85]). Even GREEN sources can
   fail from Supabase. The pressure to "just add residential proxies" or
   impersonation must be refused: that is precisely the bypass line.
3. **Nothing here was verified live.** Apart from three third-party records,
   every robots verdict is unknown, and most terms are unread. Treat this
   document as a plan for verification, not a licence to crawl.
4. **Aggregator dependencies (BidProwl, GovAuctions.app).** Redistribution
   rights are unknown, and so is the lawfulness of their upstream sourcing.
   BidProwl's free tier (1,000 calls/month, 50-newest feeds) cannot keep bids
   fresh. GovAuctions.app lacked GovDeals and Public Surplus in April 2026.
5. **eBay terms versus product features.** The keyset stays disabled until
   account-deletion compliance is in place. The licence bars AI training,
   which is a possible conflict with image embeddings, and restricts pricing
   tools. Displayed data must be less than 6 hours old.
6. **EstateSales.org's liquidated damages** ($0.25 per page, $3,000 per day)
   create concrete monetary exposure if anyone experiments against it.
7. **Maxanet fragility.** It depends on anonymous session cookies plus an XHR
   header, returns HTML fragments, and redirects to the home page when query
   parameters are missing. Its terms are unknown. Permission from Wisconsin
   Surplus is the durable fix.
8. **Schema traps.** HiBid's `bidAmount = 123.45` placeholder. Municibid's
   Eastern-Time `closing_at`. EstateSales.NET's 100-mile multi-state "city"
   results. Kansas and Wisconsin "Beloit" (`01-sources.md`). Each would put
   silent wrong values into the index.
9. **Runtime limits.** 2 s of CPU per request and no static egress IP. HTML
   parsing and partner allowlisting both need design, not afterthought (§4).
10. **The session itself.** This environment's egress allowlist and
    exhausted search budget prevented first-hand verification. The next
    research session should run with network access to the target hosts
    enabled.

---

## 8. Sources (all accessed 2026-09-27)

### 8.A Direct fetch attempts: denied by this session's egress proxy (no request reached the site)

| ID | URL | Result (2026-09-27, 03:53 UTC) |
|---|---|---|
| A1 | https://hibid.com/robots.txt | curl and WebFetch: denied (egress policy) |
| A2 | https://www.k-bid.com/robots.txt | denied |
| A3 | https://www.govdeals.com/robots.txt | denied |
| A4 | https://www.allsurplus.com/robots.txt | denied |
| A5 | https://www.publicsurplus.com/robots.txt | denied |
| A6 | https://municibid.com/robots.txt | denied |
| A7 | https://www.proxibid.com/robots.txt | denied |
| A8 | https://www.auctionzip.com/robots.txt | denied |
| A9 | https://www.bidspotter.com/robots.txt | denied |
| A10 | https://www.purplewave.com/robots.txt | denied |
| A11 | https://www.estatesales.net/robots.txt | denied |
| A12 | https://estatesales.org/robots.txt | denied |
| A13 | https://maxsold.com/robots.txt | denied |
| A14 | https://www.auctionninja.com/robots.txt | denied |
| A15 | https://www.wisconsinsurplus.com/robots.txt | denied |
| A16 | https://bidprowl.com/robots.txt | denied |
| A17 | https://govauctions.app/robots.txt | denied |
| A18 | https://www.treasury.gov/robots.txt | denied |
| A19 | https://www.usmarshals.gov/robots.txt | denied |
| A20 | https://www.irs.gov/robots.txt | denied (irsauctions.gov not attempted separately) |
| A21 | https://developer.ebay.com/robots.txt | denied |
| A22 | https://www.google.com/robots.txt | control: denied too, confirming an allowlist on our side |

### 8.O Official and first-party sources

| ID | URL | Supports | Method |
|---|---|---|---|
| O1 | https://supabase.com/docs/guides/functions/limits | Edge Function CPU, wall-clock, memory, HTML limits | Supabase docs search tool |
| O2 | https://supabase.com/docs/guides/troubleshooting/edge-function-wall-clock-time-limit-reached-Nk38bW | Wall-clock and CPU behaviour | Supabase docs search tool |
| O3 | https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0 | No static egress IPs; proxy recommendation | Supabase docs search tool |
| O4 | https://github.com/Municibid/botplugin/blob/16ee114e8ccfe88c4327641950a742a1a09b9b9e/README.md | Municibid MCP tools, terms and docs links | GitHub code search (Municibid's own org) |
| O5 | https://github.com/Municibid/botplugin/blob/16ee114e8ccfe88c4327641950a742a1a09b9b9e/mcp.json | MCP endpoint and transport | GitHub code search |
| O6 | https://github.com/Municibid/botplugin/blob/16ee114e8ccfe88c4327641950a742a1a09b9b9e/skills/municibid/references/tools.md | Auth none; 405 on GET; return fields | GitHub code search |
| O7 | https://github.com/Municibid/botplugin/blob/16ee114e8ccfe88c4327641950a742a1a09b9b9e/skills/municibid/SKILL.md | `listing_url` format; read-only use | GitHub code search |
| O8 | https://github.com/Municibid/botplugin/blob/16ee114e8ccfe88c4327641950a742a1a09b9b9e/rules/municibid-read-only.mdc | Verbatim usage rules | GitHub code search |
| O9 | https://github.com/Municibid/botplugin/blob/16ee114e8ccfe88c4327641950a742a1a09b9b9e/scripts/verify-plugin.py | Example `search_auctions` arguments | GitHub code search |
| O10 | https://ai.municibid.com/mcp | MCP endpoint (referenced, not called) | referenced in O4–O9 |
| O11 | https://info.municibid.com/terms | Municibid terms (not fetched) | referenced in O4 |
| O12 | https://info.municibid.com/municibid-chatgpt-app | Municibid app docs (not fetched) | referenced in O4, O8 |
| O13 | https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion | Keyset activation requirement (quoted via G98) | referenced |
| O14 | https://developer.ebay.com/grow/application-growth-check | Raising eBay call limits (via G98) | referenced |
| O15 | https://developer.ebay.com/api-docs/buy/browse/types/cos:FilterField | Browse filter reference (via G100, G101) | referenced |
| O16 | https://api.ebay.com/buy/browse/v1/item_summary/search | Browse search endpoint (not called) | referenced |

### 8.I Web-search index results (page text not fetched; wording may be paraphrased)

| ID | URL | Supports |
|---|---|---|
| I1 | https://hibid.com/home/termsofuse | HiBid terms clauses (§3.1 g) |
| I2 | https://farrellauctionservice.hibid.com/home/termsofuse | Tenant copy of HiBid terms |
| I3 | https://arizonaauctioncompany.hibid.com/home/termsofuse | Tenant copy of HiBid terms |
| I4 | https://gobidtoday.hibid.com/content/notices | Tenant notices page (data-mining clause) |
| I5 | https://hibid.com/home/sitemap | HiBid HTML sitemap |
| I6 | https://barsbyauctions.hibid.com/home/sitemap | Tenant HTML sitemap |
| I7 | https://help.hibid.com/en/ | HiBid help center (no RSS documentation found) |
| I8 | https://www.auctionflex.com/about-hibid.htm | HiBid / Auction Flex relationship |
| I9 | https://manateegalleries.auctionflex.com/hibid_integrated.htm | "Direct HiBid Integration" (inbound) |
| I10 | https://hibid.com/lot/316551444/smiling-salmon-nigiri-squishy-foam-toy ; https://burgessauctions.hibid.com/lot/178812194 ; https://hibid.com/www.heretn.com/lot/316337931/skyrover-s1-smart-flight-battery---sealed | Lot URL shapes |
| I11 | https://www.govdeals.com/content/site-terms | GovDeals User Agreement location |
| I12 | https://www.govdeals.com/register/registration/terms | GovDeals registration terms |
| I13 | https://www.govdeals.com/content/termsandconditions/1?companyName=GovDeals | Seller-specific terms pattern |
| I14 | https://www.govdeals.com/en/new-listings | New-listings page |
| I15 | https://prod-seo.govdeals.com/en/new-listings | SEO prerender host (do not use) |
| I16 | https://blog.govdeals.com/new-govdeals | GovDeals relaunch notes |
| I17 | https://liquidityservices.com/marketplace/govdeals | Liquidity Services marketplace page |
| I18 | https://www.allsurplus.com/account/terms-and-conditions | AllSurplus terms location |
| I19 | https://news.ycombinator.com/item?id=47662945 | GovAuctions.app Show HN |

### 8.P Prior Skeuos research (`docs/04-universal-extraction.md`; not re-verified)

| ID | URL | Supports |
|---|---|---|
| P1 | https://bidprowl.com/research | BidProwl API, MCP, free tier, coverage, feed cadence |
| P2 | https://bidprowl.com/terms | BidProwl forbids scraping; API sanctioned |
| P3 | https://govauctions.app/about | Data API, bulk licensing, free keys, MCP |
| P4 | https://govauctions.app/research/open-dataset | CC-BY 4.0 GSA dataset |
| P5 | https://huggingface.co/datasets/govauctions/us-gsa-surplus-auctions | 11.7k-row mirror |
| P6 | https://www.invaluable.com/inv/apiinfo/ | Invaluable/AuctionZip Catalog Upload API (inbound) |
| P7 | https://w.auctionflex.com/IWS_Walk_Through.htm | Auction Flex Integrated Web Service (inbound) |
| P8 | https://wavebid3.zendesk.com/hc/en-us/articles/115004794806-Link-and-Export-to-Proxibid | Proxibid Bulk Loader (inbound) |
| P9 | https://support.wavebid.com/hc/en-gb/articles/360016617298-Dual-Listing-Live-Auctions-on-Proxibid-and-Bidspotter | BidSpotter manual CSV ingest |

### 8.G Public GitHub code and docs (third-party observations, via GitHub code search)

Commit-pinned links.

| ID | URL | Supports |
|---|---|---|
| G1 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/src/foreclosure_scraper/scrapers/national/hibid_real_estate.py | HiBid Apollo GraphQL; per-host `/graphql`; `bidAmount` sentinel |
| G2 | https://github.com/mbohaychuk/CarBuyerAssistant/blob/a62580195f47f69cd383a5c9b09c2c5e1f1ccb0c/src/carbuyer/sources/hibid/source.py | Cloudflare 403 to plain httpx since 2026-07-02 |
| G3 | https://github.com/mbohaychuk/CarBuyerAssistant/blob/a62580195f47f69cd383a5c9b09c2c5e1f1ccb0c/README.md | `LotSearchLotOnly`; Cloudflare on HiBid and Proxibid |
| G4 | https://github.com/Perpalicious/encore-browser/blob/846505c3c8612b7b660e97e45310ee347a1ad658/scraper/AUTH_NOTES.md | Cloudflare TLS fingerprinting; PWA bundle; query shape |
| G5 | https://github.com/Perpalicious/encore-browser/blob/846505c3c8612b7b660e97e45310ee347a1ad658/README.md | Bearer-token workaround (out of bounds for us) |
| G6 | https://github.com/Perpalicious/encore-browser/blob/846505c3c8612b7b660e97e45310ee347a1ad658/PR_DESCRIPTION.md | Cloudflare blocks datacenter IPs |
| G7 | https://github.com/Perpalicious/encore-browser/blob/846505c3c8612b7b660e97e45310ee347a1ad658/docs/HAMMER_PRICES_PLAN.md | Datacenter IPs blocked before curl_cffi |
| G8 | https://github.com/bvd63/ZETA-VIOLIN-HUNTER/blob/4bcfffd6710a6c292167fabcf18370f6efd8fbd8/scrapers/hibid.py | 2026-09-07 GraphQL from EU IPs; `bidAmount` placeholder |
| G9 | https://github.com/bvd63/ZETA-VIOLIN-HUNTER/blob/4bcfffd6710a6c292167fabcf18370f6efd8fbd8/CLAUDE.md | Proxibid, BidSpotter blocked from EU datacenter; EstateSales JS shell |
| G10 | https://github.com/TSavo/arbitrage-scout/blob/5457c711328f531774efdc719c3043ef61c8e701/src/sources/hibid.ts | LotSearch signature; Playwright cookie approach |
| G11 | https://github.com/Bosk00/hibid-auction-watcher/blob/56dd0a299daffad80bf6253d0fff36250e14f350/hibid-app/scraper.py | LotSearch signature |
| G12 | https://github.com/colterwood/gradegap/blob/8caecd61eb3ab02443b3b94f41e639e1d4681b8d/src/marketplace/sources/hibid.js | `countAsView:false` |
| G13 | https://github.com/CarsonKopec/Auction-Tracker/blob/f4976b29959b98d1ef955eaeb972d7c554ff3354/SPEC.md | `GetLotDetails` |
| G14 | https://github.com/CarsonKopec/Auction-Tracker/blob/f4976b29959b98d1ef955eaeb972d7c554ff3354/src/adapters/hibid.js | `CurrentBidsSearch` |
| G15 | https://github.com/wagleanuj/liquidationmax/blob/c54101e9a0d110cfddfc55443941f330b402eb1c/index.py | `site_subdomain` header |
| G16 | https://github.com/essquireo0o/eBayAutoLister/blob/08cdbb0416cba5912aa478963336534bcdd38f44/ING%20eBay%20AutoLister/Services/LiquidationParser.cs | `bidAmount` 123.45 on 801 lots; `hibid-state` |
| G17 | https://github.com/revertcreations/revertcreations.com/blob/f3cba71188ac28cf9461cc0f7a41be5b151cc73e/app/Services/Drivers/HiBidDriver.php | `<script id="hibid-state">` Apollo state |
| G18 | https://github.com/dallyp22/TerraValue_Prod/blob/462faa40e58f6924422e5854f39e565722331fd4/docs/scrape-source-expansion.md | HTTP 200 Turnstile shells; no JSON-LD |
| G19 | https://github.com/AkinAD/aucky/blob/f58121a8e0c3dd45e7c46a4a9f527b97abbed335/src/content/extract.ts | Product JSON-LD on HiBid lot pages |
| G20 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/docs/HANDOFF.md | maestro headers; Akamai (2026-08-20) |
| G21 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/docs/source_reverification_2026-09-10.md | Akamai "Access Denied"; GovDeals response fields; EstateSales.NET radius |
| G22 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/docs/enumeration/enum_firms.md | GovDeals Akamai; AllSurplus 403; Municibid 200; Public Surplus grid; EstateSales.NET robots |
| G23 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/docs/enumeration_r3/r3_Polk.md | GovDeals legacy URLs return SPA shell |
| G24 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/docs/HERMES.md | Fingerprint blocks on GovDeals |
| G25 | https://github.com/dhjw/php-irc-bot/blob/cfe8b27c71693c05e9aa25c279e42af8ddd58588/bot.php | `maestroApiKey` embedded in GovDeals HTML |
| G26 | https://github.com/SimbaServices/GovDeals/blob/1b987792bab96567ca3898e7d02413c7f3cab099/app/config.py | Anonymous storefront keys |
| G27 | https://github.com/bnavveer/govdeals-scraper/blob/bbd3897aad845d3cf83c1c597b277537ba146263/README.md | GD / AD / GI business IDs |
| G28 | https://github.com/TheBengineer/AuctionScraper/blob/de6bcc9509f716767535acad503a2ab22e31ddfa/server/busses.py | `search/list` body shape |
| G29 | https://github.com/duckduckgo/tracker-radar-wiki/blob/d63799c15224bbaf05082fd600c6c7f85b93595b/docs/domains/lqdt1.com.html | maestro.lqdt1.com endpoints seen across sites |
| G30 | https://github.com/seanpeters86/kbid-browser/blob/f2bee13c8be4a5436f47a19f0956e411a03e1949/src/lib/kbid.ts | K-BID `/auction/list`, `/auction/{id}` |
| G31 | https://github.com/seanpeters86/kbid-browser/blob/f2bee13c8be4a5436f47a19f0956e411a03e1949/README.md | Markup parsing; CORS proxy use |
| G32 | https://github.com/elliotttmiller/kbid-scraper/blob/523b9437c320845b2a1d471c77a1f573c320b7be/kbid-scraper/README.md | `requests` + BeautifulSoup |
| G33 | https://github.com/elliotttmiller/kbid-scraper/blob/523b9437c320845b2a1d471c77a1f573c320b7be/kbid-scraper/kbid_categories.csv | K-BID search URL pattern |
| G34 | https://github.com/LocalProtestOrg/advantage-auction-platform/blob/d26ae9b96dd49fc0cea278bcbce6ab86ad2d22bc/tests/event-detail-attribution.test.js | K-BID `?affiliate=` links |
| G35 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/docs/enumeration_r2/r2_register_D.md | Public Surplus grid; Municibid 200; IRS and USMS 403 |
| G36 | https://github.com/rmace001/Final-Project-Search-Engine/blob/778679ffb51212dc44dea0fac06f885c10cade24/data/level31/web_301 | Public Surplus agency list URL pattern |
| G37 | https://github.com/mischat/assessments/blob/bf99a53a5c62a0e680f7296d50ba09f57e788866/resources/part-m-00125 | Public Surplus auction view URL pattern |
| G38 | https://github.com/benswork-space/airbitrage/blob/5a1dcd4e16a18e721985d6f7f154b3f35f03a2ed/src/agents/scout/sources.ts | "RSS URLs were fabricated" caution |
| G39 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/src/porsche_scraper/README.md | Municibid listed as Cloudflare |
| G40 | https://github.com/rdmgator12/awesome-chatgpt-apps/blob/55d8b05322f928037a1a64ea27dca766f206e5b3/README.md | Municibid ChatGPT app |
| G41 | https://github.com/mbohaychuk/CarBuyerAssistant/blob/a62580195f47f69cd383a5c9b09c2c5e1f1ccb0c/src/carbuyer/sources/proxibid/parser.py | Proxibid Next.js data routes; LotTimeRem |
| G42 | https://github.com/mbohaychuk/CarBuyerAssistant/blob/a62580195f47f69cd383a5c9b09c2c5e1f1ccb0c/docs/specs/2026-07-02-us-crossborder-design.md | Proxibid has no geo filter |
| G43 | https://github.com/highwaymarketingco-wq/foreclosure-scraper/blob/809d5c6713a5d27c3fa40a47c9b258ffcf73c9d0/docs/missing_lead_sources_research.md | AuctionZip 403; EstateSales.org 200 |
| G44 | https://github.com/brave/adblock-lists/blob/de05097915c8971292b8598e72aca14644da23c2/brave-lists/brave-firstparty.txt | AuctionZip PerimeterX-style sensor path |
| G45 | https://github.com/robyscar/PEEHOLE-easylist/blob/21c31e2ba1bbac6bd0a22391ba28b16333f1ce53/easyprivacy/easyprivacy_specific.txt | Same, in EasyPrivacy |
| G46 | https://github.com/meandavejustice/antiques/blob/fad6b62b1bc0b22aed27741d491db676c5a185ae/README.md | EstateSales.NET Event JSON-LD on city hubs |
| G47 | https://github.com/meandavejustice/antiques/blob/fad6b62b1bc0b22aed27741d491db676c5a185ae/config.yaml | AuctionZip and AuctionNinja URL patterns |
| G48 | https://github.com/jill-dev/kd-flipbook-catalog/blob/908e413faebb6284b343f80962820c8157d33b04/output/portland/pages/07-lots-5.html | BidSpotter catalogue and lot URLs |
| G49 | https://github.com/mthresher93/ridge/blob/bb7fc410b6649c004b80dbd9155644af7c0a238f/lib/hunt.ts | Purple Wave search URL |
| G50 | https://github.com/jeremylongshore/DiagnosticPro/blob/015072098394192b4937f4669eac5cd76b491247/.beads/interactions.jsonl | Purple Wave robots disallows (2026-08-11) |
| G51 | https://github.com/pde/tosback2-data/blob/15c5d28f3bd989e235ccf5b0135c73950a02dd30/crawls/farmprogress.com/Privacy-Policy/raw/farmprogress.com/style/superfish.fpNetwork.css.html | Purple Wave 2012 syndication widget |
| G52 | https://github.com/LocalProtestOrg/advantage-auction-platform/blob/d26ae9b96dd49fc0cea278bcbce6ab86ad2d22bc/docs/projects/phase-5d-approved-source-audit.md | EstateSales.NET and .org robots and ToS quotes |
| G53 | https://github.com/LocalProtestOrg/advantage-auction-platform/blob/d26ae9b96dd49fc0cea278bcbce6ab86ad2d22bc/docs/projects/phase-5e-lawful-event-source-program.md | Partnership classifications; Bid4Assets for USMS |
| G54 | https://github.com/MilphHunter/portfolio/blob/f099878dd05fef266996ac1f06d29a6ff016da1c/Other_Python_Projects/discord-ls-parser-bot/parse/gathering_info.py | EstateSales.NET `/api/sale-details` by coordinates |
| G55 | https://github.com/MilphHunter/portfolio/blob/f099878dd05fef266996ac1f06d29a6ff016da1c/Other_Python_Projects/discord-ls-parser-bot/parse/parse_info.py | EstateSales.NET `/api/sale-details` by ID |
| G56 | https://github.com/jgdigitaljedi/gs-scraper/blob/83c004a2dec6132b7f3e5cf19c041b92d1473e56/server/routes/proxy/sales/estatesales.js | EstateSales.NET `/api/search-details` |
| G57 | https://github.com/sigmaprojects/esdetails/blob/43fe4f25561efed07acab426819c41872866e5de/src/scraper.js | EstateSales.NET `/api/legacy/…` |
| G58 | https://github.com/Justonejewelry/Chicas-Map/blob/bf3303af7d7f71ff44a50519bda878febc82b555/docs/estate-sales-sources.md | EstateSales.org embedded sale JSON |
| G59 | https://github.com/Justonejewelry/Chicas-Map/blob/bf3303af7d7f71ff44a50519bda878febc82b555/webapp/scripts/fetch_estatesales_org.py | Same, with field list |
| G60 | https://github.com/Justonejewelry/Chicas-Map/blob/bf3303af7d7f71ff44a50519bda878febc82b555/docs/email-leads-pipeline.md | EstateSales.org email digests |
| G61 | https://github.com/Justonejewelry/Chicas-Map/blob/bf3303af7d7f71ff44a50519bda878febc82b555/daily-packs/2026-09-02-chica-update-pack.md | EstateSales.org sale URL pattern |
| G62 | https://github.com/Jonathan-Pearce/maxsold/blob/1a1729e9e5a344049f7edeb157ae4b7ef1be33e8/README.md | MaxSold `sales/search` example |
| G63 | https://github.com/Jonathan-Pearce/maxsold/blob/1a1729e9e5a344049f7edeb157ae4b7ef1be33e8/scrapers/01_extract_auction_search.py | MaxSold search parameters |
| G64 | https://github.com/Jonathan-Pearce/Auction-Price-Prediction/blob/c011f672d569151e5bf5ebb7033f2664eec5441f/docs/ITEM_SCRAPER.md | MaxSold `msapi/auctions/items` |
| G65 | https://github.com/Jonathan-Pearce/Auction-Price-Prediction/blob/c011f672d569151e5bf5ebb7033f2664eec5441f/docs/ENRICHED_ITEM_SCRAPER.md | MaxSold enriched listings endpoint |
| G66 | https://github.com/joncooper/claude-speriments/blob/87a75a4c083218ee362f3b996b33398aa7f7d7b9/apps/auction-ninja-app/backend/server.js | AuctionNinja needs Puppeteer |
| G67 | https://github.com/OriginalityAI/ai-citation-study/blob/58302b1ceff367804d500f62dbe847a4c657dbe9/samples/ymyl_29000/res_20250723_n100/780612.json | bid.wisconsinsurplus.com token URL |
| G68 | https://github.com/scirelli/auction-ebidlocal-search/blob/37b9acdb43a92d6082d654e91aacf7cf8e1c37e2/internal/pkg/ebidlocal/search/v2/CachedAuctions.go | Maxanet `GetAuctions`; `hdn_AuctionId`; tenant host |
| G69 | https://github.com/scirelli/auction-ebidlocal-search/blob/37b9acdb43a92d6082d654e91aacf7cf8e1c37e2/Makefile | `GetAuctions` with `X-Requested-With` |
| G70 | https://github.com/scirelli/auction-ebidlocal-search/blob/37b9acdb43a92d6082d654e91aacf7cf8e1c37e2/test/fixtures/internal/pkg/ebidlocal/search/v2/GetAuctions.html | Maxanet fragment; shared `filter=` token; S3 images |
| G71 | https://github.com/dataders/james-river-gooners/blob/a180e8d3950187006b48f70e24d9e4081e44c607/CLAUDE.md | Maxanet session and XHR requirements; redirect rule |
| G72 | https://github.com/dataders/james-river-gooners/blob/a180e8d3950187006b48f70e24d9e4081e44c607/scraper/scrape.py | `GetAuctionItems`, `GetCategories` |
| G73 | https://github.com/dataders/james-river-gooners/blob/a180e8d3950187006b48f70e24d9e4081e44c607/supabase/functions/cannon-proxy/index.ts | Maxanet called from a Supabase Edge Function; `RefreshItem` |
| G74 | https://github.com/MarkTech0087/PrimeAuction-Scraping-And-Autobid-using-Dashboard/blob/65c831c26024c5faa46ebdcf54b2804b9a3adc8c/1_train.json | Same `filter=` token on a third tenant |
| G75 | https://github.com/browser-use/mix-eval-go/blob/032d326ca687cbce27f9c7515927c92a28081e7e/analysis/reports/NO_AUTH_PASS_LIST.md | Wisconsin Surplus fields extractable without login |
| G76 | https://github.com/Turi-Labs/Newsletter-Editor-Agents/blob/dea7daaac09997c01ecf94a64821cbb056a36f56/knowledgebase/2026-04-30/hn_posts.md | BidProwl HN launch (https://news.ycombinator.com/item?id=47961378) |
| G77 | https://github.com/jnd0/hn-brief/blob/27c6c7c6e6f5e6de79d8efde74a2b598825db10f/summaries/2026/05/01.md | BidProwl HN discussion |
| G78 | https://github.com/jnd0/hn-brief/blob/27c6c7c6e6f5e6de79d8efde74a2b598825db10f/summaries/2026/04/06.md | GovAuctions.app sourcing; GovDeals and Public Surplus absent |
| G79 | https://github.com/punkpeye/awesome-remote-mcp-servers/blob/cb78a348cf23b2465d473eecadd63a76628de71a/README.md | GovAuctions.app MCP endpoint |
| G80 | https://github.com/AdrianKrebs/design-slop-cop/blob/e2fab6ce71ac5aef06663205d245a5b7ed96da75/results/hn-index.json | GovAuctions.app US/UK/CA/AU |
| G81 | https://github.com/esamson6-claude/gov-auctions/blob/ba542479ca010b13c13a172e689ea0c8b39e0b1c/CLAUDE.md | Treasury vehicle sales link to HiBid |
| G82 | https://github.com/esamson6-claude/gov-auctions/blob/ba542479ca010b13c13a172e689ea0c8b39e0b1c/scrapers/treasury.py | Treasury `gp` page parsed as static HTML |
| G83 | https://github.com/esamson6-claude/gov-auctions/blob/ba542479ca010b13c13a172e689ea0c8b39e0b1c/scrapers/cws.py | CWS runs most Treasury sales; calendar URL |
| G84 | https://github.com/esamson6-claude/gov-auctions/blob/ba542479ca010b13c13a172e689ea0c8b39e0b1c/scrapers/cws_lots.py | CloudFront bot rule; catalog URL |
| G85 | https://github.com/esamson6-claude/gov-auctions/blob/ba542479ca010b13c13a172e689ea0c8b39e0b1c/scrapers/common.py | CI runners: CWS 202, GSA API 403 |
| G86 | https://github.com/esamson6-claude/gov-auctions/blob/ba542479ca010b13c13a172e689ea0c8b39e0b1c/.github/workflows/daily-auctions.yml | Treasury plain HTTP from CI; headless 403 |
| G87 | https://github.com/esamson6-claude/gov-auctions/blob/ba542479ca010b13c13a172e689ea0c8b39e0b1c/data/auctions.csv | Treasury and CWS data seen through 2026-09-26 |
| G88 | https://github.com/terrellkday/gov-auction-watcher/blob/22c0356aeaf404841a93ebcc03ee6f4f23f5d4d9/scraper/auction_config.py | Treasury `rp` page; bid.cwsmarketing.com |
| G89 | https://github.com/end-of-term/eot2024/blob/b13db480ec8e1c871aa379a507f870ef9e60d334/seed-lists/sitemap-url-seeds/usmarshals_gov.txt | USMS sitemap pages |
| G90 | https://github.com/RobertGonzales1/Real_Estate_Alert_AIVibeCoded/blob/f3f2823f664154db70a82d35800428fdeb88bebd/scrapers/usmarshals.py | USMS real-property page |
| G91 | https://github.com/Kernix13/rural-homestead/blob/8121e42a11c225ce58f274f0207fc1dbe9bd2401/land-search.md | USMS real property uses reallook.com |
| G92 | https://github.com/fartbagxp/gov-domains/blob/9b2459afde57064f7a86933c9ffe72d5f32a2edd/data/tech/domain.irsauctions.gov_httpx.csv | irsauctions.gov on Akamai |
| G93 | https://github.com/end-of-term/eot2024/blob/b13db480ec8e1c871aa379a507f870ef9e60d334/seed-lists/sitemap-url-seeds/irsauctions_gov.txt | IRS sitemap `/ad/` pages |
| G94 | https://github.com/18F/analytics.usa.gov/blob/af6435ce02287576ee30504fbd4f5500496ef028/ga4-data/live/top-viewed-pages-30-days.json | IRS `/auction/items` page |
| G95 | https://github.com/arjunkai/optcg-api/blob/7b14a3c4ddbd6405e800dae832ab5d316e449b05/docs/ebay-apis.md | Browse open to registered devs; 5,000/day |
| G96 | https://github.com/salishforge/stonetrade/blob/a3f4779730381a55a5a7feae2bc290c37b2e6e58/docs/EBAY-SETUP.md | 5,000/day; 1,000 token grants/day |
| G97 | https://github.com/caiopieri/project-scout/blob/a53dca3d8f2929410de80f3983f792fceeb788f5/docs/ebay-integration.md | Default quota; check Developer Analytics |
| G98 | https://github.com/awaissulhry/nexus-commerce/blob/f70a87b890af7baa7ec2da15bd05233f796c9f2a/docs/cx-research-2026-08-29/R2-ebay.md | Account-deletion requirement quote; Growth Check |
| G99 | https://github.com/L3DigitalNet/hw-radar/blob/646809d31f4f13891ba99a8b8379583f127eedcc/docs/research/us-scraping-and-data-retention-landscape-for-a-retail-hdd-price-monitor.md | eBay User Agreement and API License summary |
| G100 | https://github.com/APIs-guru/openapi-directory/blob/f04b8d0bcd39c52e1cf3ad7a5fe744709832ae49/APIs/ebay.com/buy-browse/v1.1.0/swagger.yaml | Browse filter list |
| G101 | https://github.com/ballerina-platform/openapi-connectors/blob/81158a45a86fa9a85de4e7fbd7cdc2a529d50743/openapi/ebay.browse/client.bal | Filters; 200 per page; 10,000 per result set; required params |
| G102 | https://github.com/caohanyang/REST_OPENAPI/blob/8d1b0f419abf0cf2bf8b92afe4ddf17d2b463536/predict_page/dataset/unbal_dataset/yes/developer.ebay.com_devzone_rest_api-ref_browse_item_summary_search__get.html.html | Four pickup filters required |
| G103 | https://github.com/Pablotir/card-arbitrage/blob/a2624782151b7db397d5f2231fca0609cb171ec8/src/app/api/deals/route.ts | `sort=endingSoonest` with auctions |
| G104 | https://github.com/mvanhorn/printing-press-library/blob/5db77f4b86fa502dfb12f8ddd8b303bc278bb2f7/library/commerce/ebay/.manuscripts/20260430-074134/research/2026-04-30-074134-feat-ebay-pp-cli-brief.md | Browse response fields |
| G105 | https://github.com/WhissleAI/sidestage-copilot/blob/98266e00cf108d993d46519e32cd602b957e9040/src/ingest/ebay/deletion.ts | Keyset disabled until account-deletion compliance |
| G106 | https://github.com/tonilobaccaro/farmland/blob/218da0d4125c92f061661c84544c4186acb6da7b/docs/evidence-gathering-plan.md | Bot-manager detection signals (Cloudflare, Akamai) |
| G107 | https://github.com/GSA-TTS/10x-usagov-wrangler/blob/b9b502103a06d32b6d776c51a7d4d24dfd03ba8b/usagov_chunks/car-auctions_chunk_0.md | usa.gov links to the Treasury auctions hub and USMS asset-forfeiture page |
| G108 | https://github.com/bnavveer/govdeals-scraper/blob/bbd3897aad845d3cf83c1c597b277537ba146263/scraper.py | maestro `/search/seller` path |
| G109 | https://github.com/ywyangwangyw/usedbulk/blob/482f860226742b81a7bcd112794c9ce445799052/src/lib/collectors/govdeals-api.ts | `sortField: "auctionEndDate"`, `displayRows` |
| G110 | https://github.com/seanpeters86/kbid-browser/blob/f2bee13c8be4a5436f47a19f0956e411a03e1949/src/App.test.tsx | K-BID item URL pattern |

### 8.R Referenced endpoints and pages (named in this document, not fetched)

- HiBid: https://hibid.com/graphql · https://cdn.hibid.com/cdn/pwa/ (bundle path pattern) · https://hibid.com/lots?q={query}
- K-BID: https://www.k-bid.com/auction/list · https://www.k-bid.com/auction/list?affiliate=481577
- GovDeals / AllSurplus: https://maestro.lqdt1.com/search/list · https://www.govdeals.com/asset/{assetId}/{accountId}
- Public Surplus: https://www.publicsurplus.com/sms/all,nc/browse/cataucs?catid=15 · https://www.publicsurplus.com/sms/all,wi/browse/home (pattern)
- Municibid: https://municibid.com/search/?q=real+estate&state=North+Carolina · https://municibid.com/Listing/Details/{id}
- AuctionZip: https://www.auctionzip.com/cgi-bin/auctionsearch.cgi?zip={zip}&category=0 · https://www.auctionzip.com/{ST}-Auctioneers/
- BidSpotter: https://www.bidspotter.com/en-us/auction-catalogues/{house}/catalogue-id-{id}
- Purple Wave: https://www.purplewave.com/search?utf8=%E2%9C%93&search[keyword]={q}
- EstateSales.NET: https://www.estatesales.net/api/sale-details · https://www.estatesales.net/{ST}/{City}
- EstateSales.org: https://www.estatesales.org/estate-sales/wi
- MaxSold: https://api.maxsold.com/sales/search · https://maxsold.maxsold.com/msapi/auctions/items
- AuctionNinja: https://www.auctionninja.com/auctions
- Wisconsin Surplus: https://bid.wisconsinsurplus.com/Public/Auction/GetAuctions?filter=Current&pageSize=1000
- GovAuctions.app: https://govauctions.app/api/mcp
- Treasury: https://www.treasury.gov/auctions/treasury/gp/ · https://www.treasury.gov/auctions/treasury/rp/ · https://home.treasury.gov/services/treasury-auctions · https://cwsmarketing.com/auctions/upcoming-auctions/ · https://bid.cwsmarketing.com/auctions/catalog/id/{N}
- US Marshals: https://www.usmarshals.gov/what-we-do/asset-forfeiture · https://www.usmarshals.gov/what-we-do/asset-forfeiture/real-property
- IRS: https://www.irsauctions.gov/ · https://www.irsauctions.gov/ad/commercial-acreage
