-- 0063: Premier Machinery Auctions on (Wisconsin sales only); Iggy's held
-- with HiBid. Both were registered for review in 0062.
--
-- Read through our own crawler on 2026-10-05 (inspect-page, robots.txt first):
--
--   Premier Machinery Auctions
--     www.premiermachineryauctions.com is a BidWrangler website (auction ids
--     "bw170675", assets on bwwsplatform.com); each sale links to its bidding
--     host, bid.premiermachineryauctions.com, a BidWrangler tenant like
--     bid.hansenandyoung.com. That host's robots.txt allows /api/auctions,
--     with no Crawl-delay. /api/auctions lists 121 auctions, each declaring
--     its state: Wisconsin sales at Stevens Point and La Crosse, the rest in
--     Minnesota and North Dakota, which the adapter's state scope skips.
--     Its terms ("ONLINE Terms and Conditions - Premier Machinery Auctions,
--     LLC", last updated 4/15/2019, shown on every sale page) were searched
--     for robot, scrap, spider, crawl, automat, data min, harvest, copy,
--     reproduc, frame, redistribut, republish, aggregat, commercial purpose,
--     intellectual, proprietary and license. The one match is the bidder's
--     indemnity for misusing a third party's intellectual property; nothing
--     forbids automated access, collection or display. The same reading as
--     the five BidWrangler houses (0036).
--
--   Iggy's Auction House
--     Its site links each sale's catalog to iggysauction.hibid.com: it bids
--     on HiBid, so it is held with HiBid (docs/10 section 4). Nothing on the
--     HiBid host was fetched.
--
-- Applied with execute_sql.

update sources set
  url               = 'https://www.premiermachineryauctions.com',
  api_base          = 'https://bid.premiermachineryauctions.com',
  robots_url        = 'https://bid.premiermachineryauctions.com/robots.txt',
  robots_allows     = true,
  robots_checked_at = now(),
  ingest            = 'internal_json',
  platform          = 'bidwrangler',
  states            = array['WI'],
  rate_limit_rpm    = 20,
  crawl_cadence_min = 15,
  priority          = 25,
  active            = true,
  ingest_allowed    = true,
  ingest_note       = 'Terms read 2026-10-05 (0063): Premier''s ONLINE Terms and Conditions (4/15/2019) say nothing about automated access, collection or display. BidWrangler tenant bid.premiermachineryauctions.com; robots.txt allows /api/auctions. Wisconsin sales only (Stevens Point, La Crosse); its Minnesota and North Dakota sales are out of scope.'
where slug = 'premier-machinery-auctions';

update sources set
  ingest_note = 'Held (0063): its catalogs are on HiBid (iggysauction.hibid.com), whose terms forbid automated collection; held with HiBid until its permission (docs/10 section 4). Its own site, www.iggysauction.com, was read once on 2026-10-05 to find where it bids.'
where slug = 'iggys-auction-house';
