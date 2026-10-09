-- 0056: the "search other sites" links open where the buyer is searching.
--
-- HiBid carries most of Wisconsin's private auction lots and its terms hold
-- them back from Skeuos (docs/10 section 4), so for most household searches
-- ("bookshelf" near 53916 on 2026-10-05: no exact match among Skeuos's sources)
-- its link is where the buyer goes next. It opened HiBid's search for the words
-- alone, nationwide. HiBid's lot search takes zip= and miles= (25, 50, 100, 250
-- or 500; seen in HiBid's own URLs, e.g. /lots/?zip=50265&miles=50), and the app
-- now fills {postal} and {radius:...} (web/src/lib/elsewhere.ts), rounding the
-- radius up to a distance HiBid offers.
--
-- eBay gets a link too: local-pickup listings around the same ZIP
-- (_stpos = ZIP, _sadis = miles, LH_LPickup=1, LH_PrefLoc=99; _udhi is the
-- price cap). eBay stays deep-link only here; its API needs the owner's keys.
--
-- Data only. Applied with execute_sql after the app that reads {postal} and
-- {radius} was deployed.

update public.sources
   set search_template = 'https://hibid.com/lots?q={query}&zip={postal}&miles={radius:25,50,100,250,500}'
 where slug = 'hibid';

update public.sources
   set search_template = 'https://www.ebay.com/sch/i.html?_nkw={query}&_udhi={max_price}&LH_LPickup=1&_stpos={postal}&_sadis={radius}&LH_PrefLoc=99&_fspt=1'
 where slug = 'ebay';
