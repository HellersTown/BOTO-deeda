-- 0062: the two Wisconsin houses AuctionGuide lists that do not sell on
-- HiBid, registered for review.
--
-- On 2026-10-05 every Wisconsin sale AuctionGuide listed (37 sales, 13,216
-- lots) was checked for where it is bid. All but two houses bid on HiBid,
-- which is held on its terms (docs/10 section 4). The two that do not:
--
--   Iggy's Auction House        Wisconsin Rapids; AuctionGuide's page for its
--                               Lobner estate sale (695 lots, closing
--                               2026-10-14) gives www.iggysauction.com.
--   Premier Machinery Auctions  industrial liquidations; two Wisconsin sales
--                               (La Crosse, closing 2026-10-27, and Metal
--                               Crafters); premiermachineryauctions.com.
--
-- Each starts inactive and held with robots unchecked, as BigIron and Steffes
-- did (0039), so that its robots.txt and terms can be read through our own
-- crawler (inspect-page accepts only registered hosts) before anything else.
-- Nothing is crawled by this migration. Applied with execute_sql.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values
('iggys-auction-house', 'Iggy''s Auction House', 'https://www.iggysauction.com/',
 null, 'private', 'html', 'iggys', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-05 for review: Wisconsin Rapids estate auctioneer whose online sales are not on HiBid (AuctionGuide lists its 695-lot Lobner estate sale, closing 2026-10-14). Terms not yet read.',
 10, false, false, 60, 45,
 null, 'Estate and household auctions, timed online, central Wisconsin.',
 'https://www.iggysauction.com/robots.txt', null),

('premier-machinery-auctions', 'Premier Machinery Auctions', 'https://premiermachineryauctions.com/',
 null, 'private', 'html', 'premier-machinery', array['WI', 'MN'],
 false, false, false, false, false,
 'Registered 2026-10-05 for review: industrial liquidations, two Wisconsin sales on AuctionGuide (La Crosse tool and die shop, closing 2026-10-27; Metal Crafters facility closure), not on HiBid. Terms not yet read.',
 10, false, false, 60, 45,
 null, 'Machine shop and industrial facility liquidations, timed online.',
 'https://premiermachineryauctions.com/robots.txt', null)
on conflict (slug) do nothing;
