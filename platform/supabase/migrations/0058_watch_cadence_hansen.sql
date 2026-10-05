-- 0058: Hansen Auction Group every 10 minutes.
--
-- Measured on 2026-10-05, the first runs under 0055: a Hansen item weighs
-- ~26 KB (up to 20 photos, four signed URLs each), so a run's 32 MB budget
-- reads ~1,235 lots, while Hansen has ~4,760 open. A lot is due once unseen for
-- 40 minutes (BW_WATCH.staleMs), so every 15 minutes a run would owe ~1,190 to
-- ~1,590 lots and fall behind the hourly promise. Every 10 minutes it owes
-- ~1,060, inside the budget, with room for each sale's full read every six
-- hours. The other houses are far smaller and stay at 15 minutes.
--
-- Data only. Applied with execute_sql.

update public.sources
   set crawl_cadence_min = 10
 where slug = 'hansen-auction-group';
