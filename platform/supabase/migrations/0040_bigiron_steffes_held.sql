-- 0040: BigIron and Steffes Group stay held on their terms.
--
-- Read through our own crawler (inspect_url) on 2026-10-01:
--
--   BigIron Auctions  robots.txt allows the sale pages (Crawl-delay 5; account,
--                     bid, search and past-sale paths disallowed). Its Terms of
--                     Use (/TermsOfUse) forbid it: "Use any robot, spider, or
--                     other automatic device, process, or means to access the
--                     Services for any purpose, including monitoring or copying
--                     any of the material on the Services", and limit use to
--                     "personal, non-commercial use only". Letter: docs/10 §14.
--   Steffes Group     robots.txt allows all but /api/ and account paths. Its
--                     terms (/legal/terms, RESTRICTIONS (c)) forbid it: "use any
--                     robot, spider, scraper, data mining tool, data gathering
--                     or extraction tool, or any other automated means, to
--                     access, collect, copy or record the Services". Letter:
--                     docs/10 §15.

update sources
   set robots_allows = true,
       ingest_note   = ingest_note || ' 2026-10-01 (0040): HELD. Its Terms of Use forbid any robot or automatic means of '
                       || 'access, including monitoring or copying. Letter: docs/10 section 14.'
 where slug = 'bigiron' and ingest_note not like '%(0040)%';

update sources
   set robots_allows = true,
       ingest_note   = ingest_note || ' 2026-10-01 (0040): HELD. Its terms forbid robots, scrapers and any automated means '
                       || 'to access or copy the site. Letter: docs/10 section 15.'
 where slug = 'steffes-group' and ingest_note not like '%(0040)%';
