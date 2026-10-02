-- 0022: the second wave of terms reads (2026-09-30, docs/08 §1a). Five more
-- sources expressly forbid automated collection, so they are held like those
-- in 0019 and 0020. None has an adapter yet, so nothing was crawling them; the
-- registry now says why none will until the operator gives written permission.

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.bidspotter.com/en-us/about-us/legal/website-terms-and-conditions',
       ingest_note    = 'Held 2026-09-30. Terms (2024-06-24) §4.2: the user agrees not to "use any data mining, '
                        || 'robots or similar data gathering or extraction methods". §9 also restricts linking '
                        || 'without consent, except for "a bona fide search engine". Needs written permission.'
 where slug = 'bidspotter';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.purplewave.com/auction/legal/website',
       ingest_note    = 'Held 2026-09-30. Terms of Website Use (2025-05-15): you agree not to "Use any robot, '
                        || 'spider or other automatic device, process or means to access the Website for any '
                        || 'purpose". Needs written permission.'
 where slug = 'purple-wave';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://shopgoodwill.com/about/terms-of-use',
       ingest_note    = 'Held 2026-09-30. Terms (2025-01-22) §6: you will not "use any robot, spider, crawler, '
                        || 'scraper ... or other automated means or interface not authorized by us to access the '
                        || 'Services, extract data". robots.txt sets Crawl-delay: 120. Needs written permission.'
 where slug = 'shopgoodwill';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.liveauctioneers.com/termsandconditions',
       ingest_note    = 'Held 2026-09-30. Terms (2025-03-26) §8: "you will not use any robot, spider, scraper, or '
                        || 'other automated means to access the sites for any purpose without our express written '
                        || 'permission." Needs written permission.'
 where slug = 'liveauctioneers';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.invaluable.com/inv/agreements/terms-of-use/',
       ingest_note    = 'Held 2026-09-30. Terms (v3.11) §5.2: "you will not use any robot, spider, other automatic '
                        || 'device, or manual process to monitor or copy our web pages or the content contained '
                        || 'herein without our prior expressed written permission." Needs written permission.'
 where slug in ('invaluable', 'schrager');

update sources
   set access_note = 'robots.txt and the home page answered HTTP 403 (awselb/2.0) to our crawler on 2026-09-30; '
                     || 'terms not retrievable. Deep links only.'
 where slug = 'k-bid';

update sources
   set ingest_note = 'Terms read 2026-09-30: none published (/terms/ is 404). robots.txt states "As a condition of '
                     || 'accessing this website, you agree to abide by the following content signals": '
                     || 'search=yes, ai-train=no, use=reference. Sale-level discovery with links and short '
                     || 'excerpts is within "search"; /search/ and /calendar/ are disallowed.'
 where slug = 'auctionguide';
