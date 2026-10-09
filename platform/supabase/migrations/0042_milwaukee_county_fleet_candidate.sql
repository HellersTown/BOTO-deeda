-- 0042: Milwaukee County's fleet auction page, registered for review.
--
-- The City of Milwaukee and the City of Madison sell surplus, including
-- abandoned and towed vehicles, through Wisconsin Surplus, which is held
-- (search, 2026-10-01). Milwaukee County also sells fleet vehicles and
-- equipment at joint live auctions with the City at its Fleet Management yard
-- in Wauwatosa, and publishes them on its own page. Registered inactive and
-- held with robots unchecked, so that its robots.txt and terms can be read
-- through our own crawler first.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values
('milwaukee-county-fleet', 'Milwaukee County Fleet Auction', 'https://county.milwaukee.gov/EN/Department-of-Transportation/Operations/Fleet/Fleet-Auction',
 null, 'county', 'html', 'milwaukee-county-fleet', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: the county page for its live fleet vehicle auctions (held with the City of Milwaukee at Wauwatosa). Terms not yet read.',
 10, false, false, 60, 35,
 null, 'Milwaukee County and City of Milwaukee fleet vehicles and equipment at live auction.',
 'https://county.milwaukee.gov/robots.txt', null)
on conflict (slug) do nothing;

-- Read on 2026-10-01: county.milwaukee.gov's robots.txt could not be fetched
-- from Supabase. The inspector answered "robots.txt unreachable or refused:
-- RFC 9309 says assume disallow", so the page is not read and the source stays
-- held. The hourly probe keeps trying robots.txt, and the verdict changes only
-- if the county's server starts answering.
update sources
   set ingest_note = ingest_note || ' 2026-10-01: robots.txt could not be read from Supabase, which counts as '
                     || 'disallow, so it is not crawled. The hourly probe keeps checking.'
 where slug = 'milwaukee-county-fleet' and position('could not be read' in ingest_note) = 0;
