-- 0035: Wisconsin sale calendars and public sale pages, registered for review.
--
-- Most Wisconsin government inventory sits behind operators that forbid or
-- refuse automated access (Wisconsin Surplus, GovDeals, Public Surplus,
-- Municibid), and most private houses sell on HiBid, which is held. What is
-- left are calendars that list sales, the way AuctionGuide does, and public
-- bodies that publish their own sales. A search on 2026-10-01 found these:
--
--   Farmers Hot Line   farm auction calendar by state; Wisconsin houses list
--                      there (Dairyland of Elroy, Wilkinson of Muscoda,
--                      Northern Auction of River Falls, B and M).
--   Farm Auction Guide farm auction calendar with a Wisconsin page.
--   AuctionGuy         a directory of upcoming auctions by state.
--   Wisconsin DOR      the Department of Revenue's public auction page.
--   Dane County        the Treasurer's own tax-deed auction (next sale
--                      2026-10-06); most counties sell tax deeds through
--                      Wisconsin Surplus, which is held.
--
-- Each starts inactive and held with robots unchecked, so that its robots.txt
-- and terms can be read through our own crawler before anything else.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values
('farmers-hotline', 'Farmers Hot Line', 'https://www.farmershotline.com/auctions',
 null, 'private', 'html', 'farmers-hotline', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: farm auction calendar by state, with Wisconsin houses (Dairyland, Wilkinson, Northern Auction, B and M). Terms not yet read.',
 10, false, false, 60, 40,
 null, 'Farm, equipment and consignment auction calendar.',
 'https://www.farmershotline.com/robots.txt', null),

('farm-auction-guide', 'Farm Auction Guide', 'https://www.farmauctionguide.com/auction-location/wisconsin/',
 null, 'private', 'html', 'farm-auction-guide', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: farm auction calendar with a Wisconsin page. Terms not yet read.',
 10, false, false, 60, 40,
 null, 'Farm auction calendar, Wisconsin page.',
 'https://www.farmauctionguide.com/robots.txt', null),

('auctionguy', 'AuctionGuy', 'https://www.auctionguy.com/WI-auctions.html',
 null, 'private', 'html', 'auctionguy', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: directory of upcoming auctions by state. Terms not yet read.',
 10, false, false, 60, 45,
 null, 'Directory of upcoming Wisconsin auctions.',
 'https://www.auctionguy.com/robots.txt', null),

('wi-dor-auctions', 'Wisconsin Department of Revenue Public Auctions', 'https://www.revenue.wi.gov/Pages/PublicAuction/home.aspx',
 null, 'state', 'html', 'wi-dor', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: the Department of Revenue''s own public auction page. Terms not yet read.',
 10, false, false, 60, 30,
 null, 'State of Wisconsin Department of Revenue public auctions.',
 'https://www.revenue.wi.gov/robots.txt', null),

('dane-county-tax-deed', 'Dane County Tax Deed Auction', 'https://treasurer.danecounty.gov/taxdeedauction',
 null, 'county', 'html', 'dane-county-tax-deed', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: the Dane County Treasurer''s own tax-deed auction (next sale 2026-10-06). Terms not yet read.',
 10, false, false, 60, 30,
 null, 'Tax-deeded property auctions run by the Dane County Treasurer.',
 'https://treasurer.danecounty.gov/robots.txt', null)
on conflict (slug) do nothing;
