-- 0031: Wisconsin auction houses on BidWrangler, registered for review.
--
-- Hansen Auction Group (live since 0019) bids on BidWrangler, and the adapter
-- (adapters/bidwrangler.ts) serves any BidWrangler house: one source per
-- house, its bidding host in api_base, scoped to the auction's DECLARED state.
-- A web search for BidWrangler houses selling in Wisconsin (2026-10-01) found
-- these. Two others it surfaced are not Wisconsin houses and are not added:
-- Ken Patterson Auctions (Rock, KS) and PA Auction Center (East Earl, PA).
--
-- BidWrangler's own policy (bidwrangler.com/bidder-data) says each auction
-- house owns its auction and bidding data, so each house's own terms govern,
-- as Hansen's did. Every row therefore starts inactive and held
-- (ingest_allowed = false) with robots unchecked (robots_allows = null, which
-- the crawler reads as do-not-crawl). A later migration switches each one on
-- only after its robots.txt and terms are read and its catalogue is verified
-- against live pages.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values
('hansen-and-young', 'Hansen & Young, Inc.', 'https://www.hansenandyoung.com',
 'https://hansenandyoung.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: BidWrangler house selling in Eleva, Mondovi, Prairie Farm, St. Croix Falls and Chetek, WI. Terms not yet read.',
 20, false, false, 60, 20,
 null, 'Western Wisconsin consignment, equipment, auto and seasonal auctions.',
 'https://hansenandyoung.bidwrangler.com/robots.txt', null),

('hueckman-auction', 'Hueckman Auction', 'https://hueckmanauction.bidwrangler.com/ui',
 'https://hueckmanauction.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: BidWrangler house selling in Medford, Rib Lake and Tomahawk, WI. Terms not yet read.',
 20, false, false, 60, 20,
 null, 'North-central Wisconsin estate, farm and personal property auctions.',
 'https://hueckmanauction.bidwrangler.com/robots.txt', null),

('bennett-auction-service', 'Bennett Auction Service', 'https://bennettauctionservice.bidwrangler.com/ui',
 'https://bennettauctionservice.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: BidWrangler house in Prentice, WI. Terms not yet read.',
 20, false, false, 60, 20,
 null, 'Northern Wisconsin shop, tool, equipment and estate auctions.',
 'https://bennettauctionservice.bidwrangler.com/robots.txt', null),

('wisconsin-public-auction', 'Wisconsin Public Auction', 'https://wisconsinpublicauction.com',
 'https://wisconsinpublicauction.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: BidWrangler house in Dale, WI (cars, trucks, recreational vehicles, equipment). Terms not yet read.',
 20, false, false, 60, 20,
 null, 'Vehicle, recreational and equipment auctions in Dale, WI.',
 'https://wisconsinpublicauction.bidwrangler.com/robots.txt', null),

('north-central-sales-auction', 'North Central Sales Auction', 'https://northcentralsalesauction.bidwrangler.com/ui',
 'https://northcentralsalesauction.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: BidWrangler house selling around Wausau, Weston and Wisconsin Rapids, WI. Terms not yet read.',
 20, false, false, 60, 20,
 null, 'Central Wisconsin personal property and real estate auctions.',
 'https://northcentralsalesauction.bidwrangler.com/robots.txt', null),

('peoples-company', 'Peoples Company', 'https://peoplescompany.bidwrangler.com/ui',
 'https://peoplescompany.bidwrangler.com', 'private', 'internal_json', 'bidwrangler', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: land auction firm based outside Wisconsin; scoped to its Wisconsin land auctions (e.g. Waupaca and Grant counties). Terms not yet read.',
 20, false, false, 60, 30,
 null, 'Farmland and recreational land auctions; Wisconsin tracts only.',
 'https://peoplescompany.bidwrangler.com/robots.txt', null)
on conflict (slug) do nothing;
