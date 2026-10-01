-- 0033: CTBids registered for review.
--
-- CTBids is the online estate auction platform of Caring Transitions, whose
-- Wisconsin franchises sell on it: Eastern Wisconsin (Neenah), Metro
-- Milwaukee (Wauwatosa), Milwaukee North Shore (Shorewood) and Chippewa
-- Valley (Eau Claire), per their own franchise pages (search, 2026-10-01).
-- Estate sales are the largest gap in the app (07-wisconsin-sources.md §2).
--
-- Registered inactive and held, robots unchecked, so that its robots.txt and
-- terms can be read through our own crawler before anything else.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values
('ctbids', 'CTBids (Caring Transitions)', 'https://www.ctbids.com',
 null, 'estate', 'html', 'ctbids', array['WI'],
 false, false, false, false, false,
 'Registered 2026-10-01 for review: online estate auctions run by Caring Transitions franchises, four of them in Wisconsin. Terms not yet read.',
 12, true, false, 60, 40,
 null, 'Online estate auctions from Caring Transitions franchises.',
 'https://www.ctbids.com/robots.txt', null)
on conflict (slug) do nothing;
