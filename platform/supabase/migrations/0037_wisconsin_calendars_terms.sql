-- 0037: the terms of the sources registered by 0035, read through our own
-- crawler (inspect_url) on 2026-10-01; Dane County's tax-deed sale switched on.
--
-- APPLIED BY HAND. In production apply_migration timed out four times on this
-- file. A request filter between the SQL tool and the database stalled some
-- of the longer notes, while the database itself showed no locks. So the
-- updates were run one by one with execute_sql, with shorter notes, and the
-- migration was recorded in supabase_migrations.schema_migrations with
-- created_by 'execute_sql'. The flags it sets are exactly the ones below;
-- only the ingest_note wording differs.
--
--   Farmers Hot Line     HELD. farmershotline.com/terms-use: no material "may be
--                        copied, distributed, republished, reproduced,
--                        downloaded, displayed or transmitted in any form for
--                        commercial use without prior written permission of
--                        Catalyst Communications Network"; individual visitors
--                        get "personal, non-commercial use". Letter: docs/10 §13.
--   Farm Auction Guide   HELD. farmauctionguide.com/disclaimer (Global Auction
--                        Guide's terms): "no portion of the information on this
--                        Web site may be reproduced in any form or by any means
--                        without the prior written permission from
--                        globalauctionguide.com"; copies "solely for personal,
--                        informational, non-commercial purposes". Footer: "Part of
--                        the Global Auction Guide Media Group". Letter: §12.
--   AuctionGuy           HELD. It publishes no terms of its own, but it is the
--                        same network: its sale pages link the same sale on
--                        globalauctionguide.com, load photos from aucteeno.com and
--                        tag bid links utm_source=aucteeno&utm_medium=syndication.
--                        Global Auction Guide's terms are taken to govern it.
--                        Letter: §12. (AuctionGuide, auctionguide.com, is a
--                        different company, "© Auction Guide 1997 - 2026", and is
--                        unaffected.)
--   Wisconsin DOR        CLEAR. revenue.wi.gov's privacy page: "Unless a copyright
--                        is indicated, the information posted here is in the
--                        public domain and may be copied and distributed without
--                        permission." Switched on by 0038, once crawl-public
--                        carries its adapter.
--   Dane County          CLEAR, switched on here. robots.txt disallows only
--                        /Account; the Treasurer's site publishes no terms of use
--                        (the only terms it links are Google's, for reCAPTCHA on
--                        its forms) and its FAQ says nothing on automated access.
--                        crawl-public v3 carries the adapter: one request an hour
--                        to /taxdeedauction; parcels by municipality and parcel
--                        number, never by street address.

update sources
   set ingest_note = ingest_note || ' 2026-10-01 (0037): HELD. Terms (/terms-use) forbid copying, republishing, '
                     || 'downloading or displaying material for commercial use without written permission of Catalyst '
                     || 'Communications Network. Letter: docs/10 section 13.'
 where slug = 'farmers-hotline' and ingest_note not like '%(0037)%';

update sources
   set ingest_note = ingest_note || ' 2026-10-01 (0037): HELD. Global Auction Guide''s terms (/disclaimer) forbid '
                     || 'reproduction in any form without its prior written permission; personal, non-commercial use '
                     || 'only. Letter: docs/10 section 12.'
 where slug = 'farm-auction-guide' and ingest_note not like '%(0037)%';

update sources
   set ingest_note = ingest_note || ' 2026-10-01 (0037): HELD. No terms of its own, but part of the Global Auction '
                     || 'Guide / Aucteeno network (links the same sale on globalauctionguide.com; photos on aucteeno.com; '
                     || 'bid links tagged utm_source=aucteeno, utm_medium=syndication), whose terms forbid reproduction '
                     || 'without written permission. Letter: docs/10 section 12.'
 where slug = 'auctionguy' and ingest_note not like '%(0037)%';

update sources
   set robots_allows = true,
       ingest_note   = ingest_note || ' 2026-10-01 (0037): robots.txt blocks only SharePoint internals. revenue.wi.gov pages '
                       || 'are public domain unless a copyright is indicated. Switched on by 0038 with its adapter.'
 where slug = 'wi-dor-auctions' and ingest_note not like '%(0037)%';

update sources
   set active         = true,
       ingest_allowed = true,
       robots_allows  = true,
       ingest_note    = ingest_note || ' 2026-10-01 (0037): robots.txt disallows only /Account; no terms of use '
                        || 'published (only Google''s, for reCAPTCHA on forms). Switched on: one request an hour to '
                        || '/taxdeedauction; parcels named by municipality and parcel number, never by street address.'
 where slug = 'dane-county-tax-deed' and ingest_note not like '%(0037)%';
