-- 0029: IRS Auctions goes live; US Treasury stays off.
--
-- irsauctions.gov is a US government work (17 U.S.C. 105) whose robots.txt is
-- "User-agent: * / Allow: /". The hourly probe found it open from Supabase on
-- 2026-09-30 at 21:07, although a 2026 sweep had reported Akamai 403s. The site
-- publishes its own search index, /index.json (521,712 bytes, one card per
-- page), so the adapter reads that one file an hour: the current sales, each a
-- lot whose starting bid is the minimum bid (crawl-worker, adapters/irs-auctions.ts).
-- A card's notice text names the taxpayer and the IRS officer and is never
-- stored; rows name a place by city, state and ZIP.
--
-- treasury.gov did not answer from Supabase at first contact (20:17) nor at the
-- 21:07 probe: robots.txt unreachable, which RFC 9309 reads as disallow. The
-- row stays inactive and the probe keeps checking.

update sources
   set platform       = 'irs-auctions',
       ingest         = 'internal_json',
       active         = true,
       url            = 'https://www.irsauctions.gov',
       robots_url     = 'https://www.irsauctions.gov/robots.txt',
       rate_limit_rpm = 10,
       crawl_cadence_min = 60,
       ingest_note    = 'US government works (17 U.S.C. 105); robots.txt allows all. Read from the site''s own '
                        || '/index.json (one request an hour): current sales only, as lots with the minimum bid as the '
                        || 'starting bid. The notice text names the taxpayer and the IRS officer and is never stored.'
 where slug = 'irs-auctions';

update sources
   set ingest_note = ingest_note || ' 2026-09-30: robots.txt unreachable from Supabase at 20:17 and 21:07 (no HTTP '
                     || 'answer), which means disallow; inactive until the probe finds it answering.'
 where slug = 'us-treasury' and ingest_note not like '%unreachable from Supabase%';
