-- 0028: the third wave of terms reads (2026-09-30, docs/08 section 1a).
--
-- Four registered sources were still marked permitted although no one had
-- read their terms first-hand. inspect-page's `find` option now quotes every
-- clause on robots and scraping in one request, so they were read:
--
--   EstateSales.NET and IronPlanet forbid automated collection outright.
--   EstateSales.org's robots.txt disallows every crawler from /terms itself, so
--   its terms cannot be read by a bot; a third-party audit (docs/08 G52) quotes
--   them barring scraping with liquidated damages. Held as a precaution.
--   Proxibid publishes its agreements only as PDFs, which our tools do not
--   read; its sister site BidSpotter (Proxibid Inc) forbids data mining (0022).
--   Held as a precaution.
--
-- The RB Group terms quoted from IronPlanet also cover Ritchie Bros and
-- GovPlanet, which are already out of reach (Akamai 403, AWS WAF CAPTCHA);
-- they are held too so the registry gives the legal reason as well as the
-- technical one.
--
-- None of these has an adapter or any stored lots, so nothing changes for
-- users; the registry now says why none will be crawled.

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.estatesales.net/terms-of-service',
       ingest_note    = 'Held 2026-09-30. Terms of Service (effective 2025-10-01) expressly prohibit "using or '
                        || 'attempting to use any engine, software, tool, agent, or other device or mechanism '
                        || '(including without limitation browsers, spiders, robots, avatars, or intelligent agents) '
                        || 'to harvest or otherwise collect information from the Service for any use". Needs '
                        || 'written permission.'
 where slug = 'estatesales-net';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://estatesales.org/terms',
       ingest_note    = 'Held 2026-09-30 as a precaution. robots.txt disallows every crawler (User-agent: *) from '
                        || '/terms, so the terms were not read by our tools; a third-party audit (docs/08 G52) '
                        || 'quotes section 4.1 barring scraping, with liquidated damages for aggregation. Read them '
                        || 'in a browser before any request for permission.'
 where slug = 'estatesales-org';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.ironplanet.com/pop/terms_page.jsp',
       ingest_note    = 'Held 2026-09-30. Terms and Conditions (RB Group) section 1.3(c): you will not "use any '
                        || 'robot, spider, scraper, data mining tool, data gathering or extraction tool, or any '
                        || 'other automated means to access, collect, copy, or record the Services". Needs written '
                        || 'permission.'
 where slug = 'ironplanet';

update sources
   set ingest_allowed = false,
       ingest_note    = 'Held 2026-09-30. Ritchie Bros is RB Group, whose IronPlanet terms (section 1.3(c)) forbid '
                        || 'any automated access; its own site answers our crawler with Akamai 403s, and while held '
                        || 'the hourly probe reads only its robots.txt. Deep links only.'
 where slug in ('ritchie-bros', 'govplanet');

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.proxibid.com/asp/UnifiedUserAgreement.asp',
       ingest_note    = 'Held 2026-09-30 as a precaution. Proxibid publishes its Unified User Agreement and Data '
                        || 'Use Agreement only as PDFs (docs/ProxibidUUA.pdf), not read by our tools. Its sister '
                        || 'site BidSpotter (Proxibid Inc) forbids "any data mining, robots or similar data '
                        || 'gathering or extraction methods" (0022). Read the PDFs before any request for '
                        || 'permission.'
 where slug = 'proxibid';
