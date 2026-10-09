-- 0064: hourly sources run every 50 minutes, so each is read within the hour.
--
-- A source is due again a cadence after its run starts, and the crawl workers
-- claim due sources on a 5-minute tick, so a 60-minute source ran about every
-- 65 minutes (Dane County on 2026-10-05: 15:31, 16:36, 17:41, 18:46, 19:51).
-- The owner asked for every listing's price and bids to be watched at least
-- every hour. At 50 minutes the longest gap is 50 + 5 minutes plus the run.
--
-- These five are light: GSA 1 request a run (29 a day at this cadence, under
-- the shared DEMO_KEY's 50), IRS, the Department of Revenue and Dane County 2,
-- AuctionGuide 6. Blocked and unreachable sources are not crawled and keep
-- their cadence. Applied with execute_sql.

update sources
   set crawl_cadence_min = 50
 where slug in ('gsa-auctions', 'irs-auctions', 'wi-dor-auctions', 'dane-county-tax-deed', 'auctionguide')
   and crawl_cadence_min = 60;
