-- 0039: two Midwest equipment auctioneers with Wisconsin sales, registered for
-- review.
--
-- Nearly every Wisconsin private house that AuctionGuide lists bids on HiBid,
-- which is held, so the private equipment market outside HiBid matters most
-- for a resale buyer. A search on 2026-10-01 found:
--
--   BigIron Auctions   weekly unreserved online auctions of farm, construction
--                      and transport equipment, with Wisconsin pages
--                      (/sale/equipment-in-wisconsin, /sale/farm-equipment-in-
--                      wisconsin); terms at /TermsAndConditions.
--   Steffes Group      timed online equipment auctions, among them "Wisconsin
--                      Area Equipment Auctions" (multi-location, items at
--                      Wisconsin sites); each auction has its own terms page.
--
-- Each starts inactive and held with robots unchecked, so that its robots.txt
-- and terms can be read through our own crawler before anything else.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values
('bigiron', 'BigIron Auctions', 'https://www.bigiron.com/sale/equipment-in-wisconsin',
 null, 'private', 'html', 'bigiron', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: weekly unreserved online equipment auctions with Wisconsin pages. Terms not yet read.',
 10, false, false, 60, 35,
 null, 'Farm, construction and transport equipment sold in weekly online auctions.',
 'https://www.bigiron.com/robots.txt', null),

('steffes-group', 'Steffes Group', 'https://steffesgroup.com/Auction/EquipmentAuctions',
 null, 'private', 'html', 'steffes', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: timed online equipment auctions, including Wisconsin area sales. Terms not yet read.',
 10, false, false, 60, 40,
 null, 'Farm and construction equipment auctions, timed online.',
 'https://steffesgroup.com/robots.txt', null)
on conflict (slug) do nothing;
