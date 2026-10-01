-- seed/sources.sql
-- The source registry.
--
-- IMPORTANT SAFETY PROPERTY: every row is seeded with
--     robots_allows = null   and   verified = false
--
-- The crawler treats a null robots verdict as "do not crawl". So loading this file
-- registers sources WITHOUT authorising a single request against any of them. Each
-- one becomes crawlable only after a human (or the onboarding job) has fetched its
-- robots.txt, recorded the verdict, and captured one passing fixture.
--
-- That ordering is deliberate. It means this file can be reviewed, merged and
-- deployed with no risk of an accidental crawl of a small auctioneer's website.
--
-- `active` is set true only for sources whose URL was confirmed live this session;
-- everything else starts inactive and is promoted by hand.
--
-- Sources whose terms forbid automated collection are seeded with
-- ingest_allowed = false (HiBid and its Wisconsin tenants, Public Surplus,
-- Wisconsin Surplus, Municibid, BidSpotter, Purple Wave, ShopGoodwill,
-- LiveAuctioneers, Invaluable, Schrager, EstateSales.NET, EstateSales.org,
-- IronPlanet, Ritchie Bros, GovPlanet, Proxibid): a fresh database runs its
-- migrations before this file, so the holds of 0019, 0020, 0022 and 0028 must
-- be here too. The clauses behind each hold are quoted in docs/08 section 1a.
--
-- Idempotent: safe to re-run. Rows that already exist are left untouched.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values

-- ============================================================ TIER 1: FEDERAL

('gsa-auctions', 'GSA Auctions', 'https://www.gsaauctions.gov',
 'https://api.gsa.gov/assets/gsaauctions/v2', 'federal', 'official_api', 'gsa',
 null, true, false, false, true, true,
 'Documented public API, JSON and XML. A GSA_API_KEY already exists on the Vercel project. Highest priority: legally clean, national coverage, zero parsing risk. '
 'Spec read from github.com/GSA/auctions_api: GET {api_base}/auctions?format=JSON, auth via X-API-KEY header (or ?api_key=). Documented envelope is {"results":[...]} but the LIVE API returns {"Results":[...]} with camelCase fields (verified 2026-09-27; see packages/ingest/src/adapters/gsa.ts). '
 'Limits: 5,000 calls/day and 5 calls per 5 seconds, hence rate_limit_rpm 60. '
 'Takes NO filter parameters, so one request returns every listing from every agency and filtering happens in our own database - which means one request per crawl cycle and no pagination. '
 'TWO TRAPS: (1) PropertyState is where the item IS (pickup) while LocationST is the selling agency''s state - mapping the wrong one hides Wisconsin inventory from Wisconsin buyers. '
 '(2) AucEndDt is 10 chars, a DATE WITH NO TIME, and sales soft-close after InactivityTime minutes of no bidding, so the true close is indeterminate from the API alone. Do not promise second-level countdowns on GSA lots. '
 'Cadence 60, not 30, while the crawler runs on api.data.gov''s shared DEMO_KEY (30 calls/hour and 50/day per IP, and Edge Function IPs are shared): 24 calls/day leaves headroom. Return it to 30 once GSA_API_KEY is set as a Supabase secret.',
 60, false, false, 60, 0,
 null, 'Federal surplus across all participating agencies.',
 'https://www.gsaauctions.gov/robots.txt', null),

('govdeals', 'GovDeals', 'https://www.govdeals.com',
 null, 'county', 'internal_json', 'liquidity-services', null,
 false, false, false, true, true,
 'Carries a large share of Wisconsin county and municipal sellers as well as federal. Find the JSON endpoint the site''s own search UI calls before considering HTML parsing.',
 20, true, false, 60, 5,
 null, 'Government surplus: counties, municipalities, agencies.',
 'https://www.govdeals.com/robots.txt', null),

('public-surplus', 'Public Surplus', 'https://www.publicsurplus.com',
 null, 'school', 'internal_json', 'public-surplus', null,
 false, false, false, true, false,
 'Schools, municipalities, state agencies. Searchable by keyword and state.',
 20, true, false, 60, 10,
 null, 'Surplus from schools and local government.',
 'https://www.publicsurplus.com/robots.txt', null),

('municibid', 'Municibid', 'https://municibid.com',
 null, 'municipal', 'internal_json', 'municibid', null,
 false, false, false, true, false,
 'Private platform, government sellers. Strongest in the Northeast but carries Midwest inventory.',
 20, true, false, 60, 25,
 null, 'Government equipment and vehicles, public bidding.',
 'https://municibid.com/robots.txt', null),

('allsurplus', 'AllSurplus (Liquidity Services)', 'https://www.allsurplus.com',
 null, 'federal', 'internal_json', 'liquidity-services', null,
 false, false, false, false, true,
 'URL not independently confirmed this session. Verify before activating.',
 20, true, false, 60, 40,
 null, 'Industrial and fleet surplus.',
 'https://www.allsurplus.com/robots.txt', null),

('govplanet', 'GovPlanet', 'https://www.govplanet.com',
 null, 'federal', 'internal_json', 'ritchie-bros', null,
 false, false, false, false, false,
 'Ex-military vehicles and equipment. URL not independently confirmed this session.',
 20, true, false, 60, 45,
 null, 'Ex-military vehicles, parts and equipment.',
 'https://www.govplanet.com/robots.txt', null),

('us-marshals', 'US Marshals Asset Forfeiture', 'https://www.usmarshals.gov/assets',
 null, 'federal', 'html', null, null,
 false, false, false, false, true,
 'Low volume, high interest. Verify current host before activating.',
 10, false, false, 60, 60,
 null, 'Seized and forfeited federal assets.',
 'https://www.usmarshals.gov/robots.txt', null),

('us-treasury', 'US Treasury Seized Property Auctions', 'https://www.treasury.gov/auctions/treasury/gp/',
 null, 'federal', 'html', 'treasury', null,
 false, false, false, false, true,
 'US government works (17 U.S.C. 105). Sale-level pages: /auctions/treasury/gp/ (general property, vehicles, vessels, aircraft) and /auctions/treasury/rp/ (real estate). Lots run on contractors: CWS Marketing (AWS WAF; deep links only) and some vehicle sales on HiBid (held on its terms).',
 10, false, false, 60, 20,
 null, 'Seized and forfeited property sold for the Treasury Forfeiture Fund.',
 'https://www.treasury.gov/robots.txt', null),

('irs-auctions', 'IRS Auctions', 'https://www.irsauctions.gov',
 null, 'federal', 'internal_json', 'irs-auctions', null,
 false, false, false, true, true,
 'US government works (17 U.S.C. 105); robots.txt allows all. Read from the site''s own /index.json (one request an hour): current sales only, as lots with the minimum bid as the starting bid. The notice text names the taxpayer and the IRS officer and is never stored.',
 10, false, false, 60, 30,
 null, 'Property seized by the IRS for unpaid federal taxes.',
 'https://www.irsauctions.gov/robots.txt', null),

-- ================================================= TIER 2: WISCONSIN STATE/LOCAL

('wisconsin-surplus', 'Wisconsin Surplus Online Auction', 'https://wisconsinsurplus.com',
 null, 'state', 'html', 'custom-dotnet', array['WI','IL','MI','IA','MN'],
 false, false, false, true, false,
 'THE most important Wisconsin source. A PRIVATE company (Mount Horeb) that is a contracted vendor for the State of Wisconsin: state vehicle auctions, DNR, Revenue (unclaimed and seized property), Corrections, Health Services, UW campuses and technical colleges; also the de facto county channel (22+ counties including every sheriff office found) and the cities of Milwaukee, Madison, Janesville and Kenosha. tier is state because that is what the inventory IS, not what the company is. Research 2026-09-27 (docs/07): the Department of Administration also names GovDeals for state online auctions, so the state uses more than one channel. '
 'CRITICAL: bidding host is bid.wisconsinsurplus.com and auction IDs are opaque URL-encoded tokens (e.g. AuctionId=wTEQql9u1r8eDoI02hWnbw%3D%3D). Lot URLs CANNOT be constructed - the listing index must be crawled and links followed. '
 'Before writing the adapter, determine whether those tokens are stable across sessions. If they are not, external_id must be derived from stable content (auction number such as #25-832 plus lot number), or every crawl will create duplicate rows instead of updating existing ones.',
 12, true, false, 60, 1,
 null, 'State of Wisconsin plus county, municipal and school surplus.',
 'https://wisconsinsurplus.com/robots.txt', null),

('uw-swap', 'UW-Madison SWAP', 'https://swapauction.wisc.edu',
 null, 'school', 'html', null, array['WI'],
 false, false, false, true, true,
 'UW-Madison Surplus With A Purpose runs its own auction site (evidence: swapauction.wisc.edu/About, docs/07). 25+ new listings each weekday. Verona, WI.',
 10, false, false, 60, 55,
 null, 'University of Wisconsin surplus property.',
 'https://swapauction.wisc.edu/robots.txt', null),

-- ======================================================== TIER 3: PLATFORMS

('hibid', 'HiBid', 'https://hibid.com',
 null, 'private', 'json_ld', 'hibid', null,
 false, false, false, true, false,
 'HIGHEST-LEVERAGE ADAPTER IN THE PROJECT. Nearly every small and mid-size Wisconsin auction house runs on HiBid/AuctionFlex. Each tenant gets a *.hibid.com subdomain, and some additionally run white-label on their own domain (e.g. bids.beloitauction.com) - the SAME platform, so one adapter serves both. '
 'RSS: UNVERIFIED, has_rss is false. An earlier note here claimed per-auctioneer RSS exists; that came from a snippet saying third-party TOOLS can export HiBid data as RSS, which is not the same as the platform emitting a feed. Research found no confirmed native RSS on any major auction platform. Probe /rss, /feed and a <link rel=alternate> tag before believing otherwise. '
 'JSON-LD IS A FLOOR, NOT A SOLUTION: schema.org has no Auction type, no Bid type, and no bidCount, currentBid, reservePrice or estimate property, so even perfect markup cannot state that a price is a live bid rather than a fixed ask. Expect title, image, price-at-crawl-time and close time from JSON-LD; bid_count, reserve_met, estimates and buyer premium must come from the internal JSON endpoint or embedded app state. '
 'Check JSON-LD first: if lot pages carry schema.org Product markup, this source moves from brittle HTML parsing to durable structured ingestion for free. '
 'hibid.com/wisconsin and wisconsin-s.hibid.com are state-scoped entry points; hibid.com/wisconsin/companysearch enumerates auctioneers and is the right discovery surface for adding tenants.',
 20, false, false, 30, 2,
 'https://hibid.com/lots?q={query}', 'Dominant US platform for independent auctioneers.',
 'https://hibid.com/robots.txt', null),

('proxibid', 'Proxibid', 'https://www.proxibid.com',
 null, 'private', 'internal_json', 'proxibid', null,
 false, false, false, false, false,
 'Mid and large houses, equipment-heavy. URL not independently confirmed this session.',
 20, true, false, 60, 30,
 null, 'Live and timed auctions, equipment and collectibles.',
 'https://www.proxibid.com/robots.txt', null),

('auctionzip', 'AuctionZip', 'https://www.auctionzip.com',
 null, 'private', 'html', 'auctionzip', null,
 false, false, false, true, true,
 'Primarily a DIRECTORY, not a lot feed. Its real value is DISCOVERY: auctionzip.com/wi.html enumerates Wisconsin auction houses to add as sources. Use it to build the source registry, not to ingest lots.',
 10, false, false, 60, 70,
 null, 'Directory of US auction houses and upcoming sales.',
 'https://www.auctionzip.com/robots.txt', null),

('gotoauction', 'GoToAuction', 'https://www.gotoauction.com',
 null, 'private', 'html', null, null,
 false, false, false, true, true,
 'Directory. Use for discovery of Wisconsin houses (gotoauction.com/states/viewAll/49/), not for lots.',
 10, false, false, 60, 72,
 null, 'Directory of auctions by state and city.',
 'https://www.gotoauction.com/robots.txt', null),

('auctionguide', 'AuctionGuide', 'https://www.auctionguide.com',
 null, 'private', 'html', null, null,
 false, false, false, true, true,
 'Directory. Discovery only.',
 10, false, false, 60, 74,
 null, 'Directory of upcoming auctions by location.',
 'https://www.auctionguide.com/robots.txt', null),

('invaluable', 'Invaluable', 'https://www.invaluable.com',
 null, 'private', 'internal_json', 'invaluable', null,
 false, false, false, true, false,
 'Art, antiques, collectibles. Already an aggregator itself, so read its terms carefully - aggregating an aggregator is the case most likely to draw a complaint. Schrager Galleries (Milwaukee, WI) lists here.',
 10, true, false, 60, 80,
 null, 'Global art and antiques auction aggregator.',
 'https://www.invaluable.com/robots.txt', null),

('liveauctioneers', 'LiveAuctioneers', 'https://www.liveauctioneers.com',
 null, 'private', 'internal_json', 'liveauctioneers', null,
 false, false, false, true, false,
 'Art, antiques, collectibles. Krueger & Krueger LLC (WI) lists here. Same aggregator-of-aggregator caution as Invaluable.',
 10, true, false, 60, 82,
 null, 'Live and timed art and collectibles auctions.',
 'https://www.liveauctioneers.com/robots.txt', null),

('purple-wave', 'Purple Wave', 'https://www.purplewave.com',
 null, 'dealer', 'internal_json', 'purple-wave', null,
 false, false, false, true, false,
 'No-reserve absolute auctions, ag and construction equipment. Strong Midwest and Plains inventory - directly relevant to Wisconsin.',
 20, true, false, 60, 35,
 null, 'No-reserve agricultural and construction equipment.',
 'https://www.purplewave.com/robots.txt', null),

('k-bid', 'K-BID', 'https://www.k-bid.com',
 null, 'private', 'internal_json', 'k-bid', array['MN','WI','IA','ND','SD'],
 false, false, false, false, true,
 'Minnesota-centred with heavy upper-Midwest overlap. Directly relevant to Wisconsin buyers. URL not confirmed this session.',
 20, true, false, 60, 38,
 null, 'Upper-Midwest online auctions.',
 'https://www.k-bid.com/robots.txt', null),

('nellis', 'Nellis Auction', 'https://www.nellisauction.com',
 null, 'wholesale', 'internal_json', 'nellis', null,
 false, false, false, false, true,
 'ON HOLD: owner deferred wholesale on 2026-09-27. Retail returns and overstock. Has a well-regarded mobile app worth studying for UX. Pickup-location bound, so geo matters.',
 20, true, false, 60, 50,
 null, 'Overstock and retail returns at auction.',
 'https://www.nellisauction.com/robots.txt', null),

('equipmentfacts', 'EquipmentFacts / AuctionTime', 'https://www.equipmentfacts.com',
 null, 'dealer', 'internal_json', 'sandhills', null,
 false, false, false, false, true,
 'Sandhills platform. Ag and construction equipment - very relevant to Wisconsin farm auctions. URL not confirmed this session.',
 20, true, false, 60, 42,
 null, 'Agricultural and construction equipment auctions.',
 'https://www.equipmentfacts.com/robots.txt', null),

-- ========================================= TIER 4: WISCONSIN PRIVATE HOUSES
-- All confirmed live this session. Each runs on a platform above, so these are
-- TENANTS, not new adapters - which is the whole point of platform-shaped design.

('hamele', 'Hamele Auction Service', 'https://www.hameleauctions.com',
 null, 'private', 'json_ld', 'hibid', array['WI'],
 false, false, false, true, false,
 'Central Wisconsin, 30+ years. Bidding at hameleauctions.hibid.com - a HiBid tenant, so the HiBid adapter serves it. '
 'Terms observed: 10% online buyer premium plus 3.5% for card payment. Record both on the auction so the displayed total is honest.',
 10, false, false, 60, 15,
 null, 'Central Wisconsin estate, farm and equipment auctions.',
 'https://hameleauctions.hibid.com/robots.txt', null),

('beloit-auction', 'Beloit Auction & Realty', 'https://www.beloitauction.com',
 null, 'private', 'json_ld', 'hibid', array['WI','IL'],
 false, false, false, true, false,
 'Beloit, WISCONSIN (not Kansas - see the warning below). 50+ years, southern WI and northern IL. Bidding at bids.beloitauction.com, which is a WHITE-LABEL HiBid instance on a custom domain: same platform, different hostname. Proof that adapters must key on platform, not on domain.',
 10, false, false, 60, 16,
 null, 'Southern Wisconsin estate and real estate auctions.',
 'https://bids.beloitauction.com/robots.txt', null),

('wisconsin-auction-co', 'Wisconsin Auction Company', 'https://auctionwi.hibid.com',
 null, 'private', 'json_ld', 'hibid', array['WI'],
 false, false, false, true, false,
 'HiBid tenant.',
 10, false, false, 60, 18,
 null, 'Wisconsin general auctions.',
 'https://auctionwi.hibid.com/robots.txt', null),

('hansen-auction-group', 'Hansen Auction Group', 'https://www.hansenauctiongroup.com',
 null, 'private', 'html', null, array['WI'],
 false, false, false, true, true,
 'WISCONSIN operation: equipment, farm, business and real estate. '
 'DATA TRAP - DO NOT CONFLATE: hansenonlineauction.hibid.com is "Hansen Auction & Realty" of Beloit, KANSAS, a DIFFERENT company. There is a Beloit in both states and a Hansen auction house in each. Never infer state from a city name; require an explicit state or geocode the full address.',
 10, false, false, 60, 20,
 null, 'Wisconsin equipment, farm and real estate auctions.',
 'https://www.hansenauctiongroup.com/robots.txt', null),

-- Wisconsin houses on BidWrangler (0031, 0032): five switched on after their
-- robots.txt and terms were read; Wisconsin Public Auction's tenancy reads
-- "Platform access suspended" with Disallow: /, so it stays off.
('hansen-and-young', 'Hansen & Young, Inc.', 'https://www.hansenandyoung.com',
 'https://bid.hansenandyoung.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, true, true,
 'BidWrangler house selling in Eleva, Mondovi, Prairie Farm, St. Croix Falls and Chetek, WI, at its own bidding domain. Terms read 2026-10-01: no site-wide terms, no clause on automated access in its auctions'' text.',
 20, false, false, 60, 20,
 null, 'Western Wisconsin consignment, equipment, auto and seasonal auctions.',
 'https://bid.hansenandyoung.com/robots.txt', null),

('hueckman-auction', 'Hueckman Auction', 'https://hueckmanauction.bidwrangler.com/ui',
 'https://hueckmanauction.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, true, true,
 'BidWrangler house selling in Medford, Rib Lake and Tomahawk, WI. Terms read 2026-10-01: none forbid automated access.',
 20, false, false, 60, 20,
 null, 'North-central Wisconsin estate, farm and personal property auctions.',
 'https://hueckmanauction.bidwrangler.com/robots.txt', null),

('bennett-auction-service', 'Bennett Auction Service', 'https://bennettauctionservice.bidwrangler.com/ui',
 'https://bennettauctionservice.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, true, true,
 'BidWrangler house in Prentice, WI. Terms read 2026-10-01: none forbid automated access.',
 20, false, false, 60, 20,
 null, 'Northern Wisconsin shop, tool, equipment and estate auctions.',
 'https://bennettauctionservice.bidwrangler.com/robots.txt', null),

('north-central-sales-auction', 'North Central Sales Auction', 'https://northcentralsalesauction.bidwrangler.com/ui',
 'https://northcentralsalesauction.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, true, true,
 'BidWrangler house selling around Wausau, Weston and Wisconsin Rapids, WI. Terms read 2026-10-01: none forbid automated access.',
 20, false, false, 60, 20,
 null, 'Central Wisconsin personal property and real estate auctions.',
 'https://northcentralsalesauction.bidwrangler.com/robots.txt', null),

('peoples-company', 'Peoples Company', 'https://peoplescompany.bidwrangler.com/ui',
 'https://peoplescompany.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, true, true,
 'Land auction firm based outside Wisconsin, scoped to its Wisconsin tracts. Terms read 2026-10-01: none forbid automated access.',
 20, false, false, 60, 30,
 null, 'Farmland and recreational land auctions; Wisconsin tracts only.',
 'https://peoplescompany.bidwrangler.com/robots.txt', null),

('wisconsin-public-auction', 'Wisconsin Public Auction', 'https://wisconsinpublicauction.com',
 'https://wisconsinpublicauction.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, false, false,
 'Dale, WI (vehicles and equipment). Its BidWrangler host''s robots.txt reads "Platform access suspended for this company" with Disallow: /. Not crawled.',
 20, false, false, 60, 20,
 null, 'Vehicle, recreational and equipment auctions in Dale, WI.',
 'https://wisconsinpublicauction.bidwrangler.com/robots.txt', null),

('schrager', 'Schrager Auction Galleries', 'https://www.schragerauction.com',
 null, 'private', 'internal_json', 'invaluable', array['WI'],
 false, false, false, false, false,
 'Milwaukee, WI (2915 N Sherman Blvd). Lists via Invaluable. Own-domain URL not confirmed this session.',
 10, false, false, 60, 48,
 null, 'Milwaukee estate and fine art auctions.',
 'https://www.schragerauction.com/robots.txt', null),

('krueger-montello', 'Krueger Real Estate Auction Service', 'https://www.auctionzip.com/WI-Auctioneers/46854.html',
 null, 'private', 'html', 'auctionzip', array['WI'],
 false, false, false, false, true,
 'Montello, WI. Currently only discoverable via AuctionZip; find their own site or platform before activating.',
 6, false, false, 60, 85,
 null, 'Montello, Wisconsin real estate and estate auctions.',
 null, null),

-- ===================================================== TIER 5: ESTATE SALES
-- Mostly NOT auctions: many are fixed-price, walk-in, first-come. Model as events
-- with items rather than lots with bids.

('estatesales-net', 'EstateSales.NET', 'https://www.estatesales.net',
 null, 'estate', 'internal_json', 'estatesales-net', null,
 false, false, false, true, false,
 'Category leader. Its map/radius UX is well reviewed - study it as a UX reference for our own zip filter.',
 15, true, false, 60, 52,
 null, 'Estate sale listings with map and radius search.',
 'https://www.estatesales.net/robots.txt', null),

('estatesales-org', 'EstateSales.org', 'https://estatesales.org',
 null, 'estate', 'html', null, null,
 false, false, false, true, false,
 'Wisconsin listings confirmed at estatesales.org/estate-sales/wi.',
 10, false, false, 60, 58,
 null, 'Estate sale and estate auction listings by state.',
 'https://estatesales.org/robots.txt', null),

('maxsold', 'MaxSold', 'https://www.maxsold.com',
 null, 'estate', 'internal_json', 'maxsold', null,
 false, false, false, false, true,
 'Genuine online bidding rather than fixed price. URL not confirmed this session.',
 15, true, false, 60, 62,
 null, 'Estate contents sold by online auction.',
 'https://www.maxsold.com/robots.txt', null),

-- ====================================================== TIER 6: MARKETPLACES

('ebay', 'eBay', 'https://www.ebay.com',
 'https://api.ebay.com/buy/browse/v1', 'marketplace', 'official_api', 'ebay', null,
 true, false, false, true, true,
 'Browse API for auction search. A production keyset named "Waystock" already exists but is DISABLED and must be enabled before use. '
 'placeProxyBid exists via the Offer API but is Limited Release: requires eBay approval and a signed contract. Treat as business development, not engineering.',
 120, false, false, 15, 8,
 null, 'Global marketplace including timed auctions.',
 null, true),

('facebook-marketplace', 'Facebook Marketplace', 'https://www.facebook.com/marketplace',
 null, 'marketplace', 'deeplink_only', 'meta', null,
 false, false, false, true, false,
 'DO NOT INGEST. No public API, terms clearly prohibit automated collection, actively defended, and Meta has litigated against scrapers successfully. '
 'ingest_allowed is FALSE deliberately. We construct a search deep link from the user''s hunt and hand off with a tap - the user still gets the search and we take on none of the exposure.',
 0, true, true, 0, 99,
 'https://www.facebook.com/marketplace/{location}/search?query={query}&maxPrice={max_price}',
 'Deep-link handoff only. Never crawled.',
 null, false),

('craigslist', 'Craigslist', 'https://craigslist.org',
 null, 'marketplace', 'deeplink_only', 'craigslist', null,
 false, false, false, true, false,
 'DO NOT INGEST. Same posture as Marketplace: hostile to automation and litigious. Deep link only.',
 0, false, false, 0, 99,
 'https://{region}.craigslist.org/search/sss?query={query}&max_price={max_price}',
 'Deep-link handoff only. Never crawled.',
 null, false),

-- ============================== TIER 7: COIN SPECIALISTS (REFERENCE CORPUS)
-- These are NOT where the bargains are - they catalogue meticulously and price
-- efficiently. They are the corpus we embed to LEARN what things look like, so we
-- can then find those things in the general auctions of Tiers 2-4, where "lot of
-- assorted coins" hides varieties nobody recorded.

('heritage', 'Heritage Auctions', 'https://www.ha.com',
 null, 'dealer', 'internal_json', 'heritage', null,
 false, false, false, false, true,
 'Largest US collectibles house. Excellent, consistent photography - the ideal reference corpus for CLIP embeddings. Use to train recognition, not to hunt bargains.',
 10, true, false, 60, 90,
 null, 'Coins, currency, comics and collectibles.',
 'https://www.ha.com/robots.txt', null),

('greatcollections', 'GreatCollections', 'https://www.greatcollections.com',
 null, 'dealer', 'internal_json', null, null,
 false, false, false, false, true,
 'High-volume weekly coin auctions. Strong reference corpus: every lot is graded and photographed to a standard.',
 10, true, false, 60, 92,
 null, 'Certified coin auctions, weekly.',
 'https://www.greatcollections.com/robots.txt', null),

('stacks-bowers', 'Stack''s Bowers Galleries', 'https://www.stacksbowers.com',
 null, 'dealer', 'internal_json', null, null,
 false, false, false, false, true,
 'Reference corpus for numismatics.',
 10, true, false, 60, 94,
 null, 'Rare coin and currency auctions.',
 'https://www.stacksbowers.com/robots.txt', null),

-- ================================ ADDED 2026-09-27: RECONCILED LEGACY SOURCES
-- These 11 existed in production (created by the earlier Waystock app on
-- 2026-06-03) but not in this seed. They are added here so the seed is the single
-- source of truth: re-running it against an empty database reproduces production.

('bidspotter', 'BidSpotter', 'https://www.bidspotter.com',
 null, 'private', 'html', 'atg', null,
 false, false, false, true, false,
 'Auction Technology Group marketplace: commercial, industrial and business-liquidation sales from many houses. No Wisconsin sellers found by research (docs/07); kept for industrial equipment coverage.',
 10, true, false, 60, 60,
 null, 'Industrial and commercial auctions from many auction houses.',
 'https://www.bidspotter.com/robots.txt', null),

('ironplanet', 'IronPlanet', 'https://www.ironplanet.com',
 null, 'dealer', 'internal_json', 'ritchie-bros', null,
 false, false, false, true, false,
 'Ritchie Bros online marketplace for used equipment. Sister of GovPlanet. Nationwide; Wisconsin pickup locations appear regularly.',
 10, true, false, 60, 44,
 null, 'Used heavy equipment, trucks and ag machinery.',
 'https://www.ironplanet.com/robots.txt', null),

('ritchie-bros', 'Ritchie Bros', 'https://www.rbauction.com',
 null, 'dealer', 'internal_json', 'ritchie-bros', null,
 false, false, false, true, false,
 'Unreserved heavy-equipment auctions, live and online. Same corporate platform as IronPlanet and GovPlanet.',
 10, true, false, 60, 46,
 null, 'Unreserved equipment and truck auctions.',
 'https://www.rbauction.com/robots.txt', null),

('copart', 'Copart', 'https://www.copart.com',
 null, 'dealer', 'html', 'copart', null,
 false, false, false, false, true,
 'Salvage and used-vehicle auctions. Many lots require a dealer licence or broker in Wisconsin. Inactive until the live probe shows public, crawl-permitted access; known for aggressive bot protection.',
 10, true, false, 60, 88,
 null, 'Salvage, insurance and used vehicles.',
 'https://www.copart.com/robots.txt', null),

('iaai', 'IAA (Insurance Auto Auctions)', 'https://www.iaai.com',
 null, 'dealer', 'html', 'iaai', null,
 false, false, false, false, true,
 'Salvage vehicles, same posture as Copart: inactive until the probe shows public, crawl-permitted access.',
 10, true, false, 60, 89,
 null, 'Salvage and insurance vehicles.',
 'https://www.iaai.com/robots.txt', null),

('propertyroom', 'PropertyRoom', 'https://www.propertyroom.com',
 null, 'municipal', 'internal_json', 'propertyroom', null,
 false, false, false, true, true,
 'Police-department seized, forfeited and unclaimed property, sold online for hundreds of agencies. Ships nationwide, so relevant to Wisconsin buyers without a Wisconsin address.',
 10, true, false, 60, 36,
 null, 'Police seized and unclaimed property auctions.',
 'https://www.propertyroom.com/robots.txt', null),

('shopgoodwill', 'ShopGoodwill', 'https://shopgoodwill.com',
 null, 'private', 'internal_json', 'shopgoodwill', null,
 false, false, false, true, false,
 'Nonprofit online auctions from Goodwill stores nationwide. Thin, hurried descriptions and real photos make it one of the best SLEEPER sources there is. Most lots ship.',
 10, true, false, 60, 32,
 null, 'Goodwill online auctions; ships nationwide.',
 'https://shopgoodwill.com/robots.txt', null),

('jones-auction-service', 'Jones Auction Service', 'https://jonesauctionservice.hibid.com',
 null, 'private', 'json_ld', 'hibid', array['WI'],
 false, false, false, true, false,
 'HiBid tenant (jonesauctionservice). Location unconfirmed by research (docs/07, confidence low): verify it is the Wisconsin company before trusting the state.',
 10, false, false, 60, 22,
 null, 'Wisconsin auction house on HiBid.',
 'https://jonesauctionservice.hibid.com/robots.txt', null),

('smith-auctions', 'Smith Auctions', 'https://smithauctions.hibid.com',
 null, 'private', 'json_ld', 'hibid', array['WI','MN'],
 false, false, false, true, false,
 'HiBid tenant (smithauctions, "Smith Sales LLC"). Location unconfirmed by research (docs/07, confidence low).',
 10, false, false, 60, 24,
 null, 'Upper-Midwest auction house on HiBid.',
 'https://smithauctions.hibid.com/robots.txt', null),

-- WHOLESALE: ON HOLD by owner decision, 2026-09-27. Registered, never crawled.
('b-stock', 'B-Stock', 'https://bstock.com',
 null, 'wholesale', 'internal_json', 'b-stock', null,
 false, false, false, false, false,
 'ON HOLD: owner deferred wholesale on 2026-09-27. B2B liquidation marketplaces; most require buyer registration and approval, which puts listing data behind access control.',
 0, true, true, 60, 99,
 null, 'Retailer liquidation marketplaces (B2B).',
 'https://bstock.com/robots.txt', null),

('liquidation-com', 'Liquidation.com', 'https://www.liquidation.com',
 null, 'wholesale', 'internal_json', 'liquidity-services', null,
 false, false, false, false, false,
 'ON HOLD: owner deferred wholesale on 2026-09-27. Liquidity Services wholesale lots.',
 0, true, false, 60, 99,
 null, 'Wholesale liquidation lots.',
 'https://www.liquidation.com/robots.txt', null)

on conflict (slug) do nothing;
  -- A row that exists is never changed by this file. The live registry is kept
  -- by migrations (0019 onward): terms holds with their verbatim clauses (0020,
  -- 0022), platforms, states, pacing and robots verdicts. Re-running an upsert
  -- here would silently undo them; with DO NOTHING, re-running only adds rows
  -- the database lacks.
