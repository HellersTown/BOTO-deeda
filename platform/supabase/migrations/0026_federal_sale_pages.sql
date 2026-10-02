-- 0026: register the federal sale pages (docs/08 sections 3.17 and 3.19).
--
-- Treasury's seized-property sales and IRS Auctions are US government works
-- (17 U.S.C. 105): no copyright, and no terms that forbid reading them. Both
-- are low volume and national, with the odd Wisconsin sale; they suit the
-- sale-level rows of 0023. The lots themselves sit with contractors: CWS
-- Marketing answers AWS WAF challenges to crawlers (deep links only), and some
-- Treasury vehicle sales run on HiBid (held on its terms).
--
-- Registered inactive with robots_allows null, like every seeded source: this
-- authorises no crawl. It lets the hourly probe and inspect-page read the
-- pages from Supabase, so an adapter is written against what they serve.
-- The US Marshals row stays as it is: the probe records Akamai 403s there,
-- and it stays deep-link only.

insert into sources (
  slug, name, url, api_base, tier, ingest, platform, states,
  has_api, has_rss, verified, active, ingest_allowed, ingest_note,
  rate_limit_rpm, requires_js, auth_required, crawl_cadence_min, priority,
  search_template, description, robots_url, robots_allows
) values
('us-treasury', 'US Treasury Seized Property Auctions', 'https://www.treasury.gov/auctions/treasury/gp/',
 null, 'federal', 'html', 'treasury', null,
 false, false, false, false, true,
 'US government works (17 U.S.C. 105). Sale-level pages: /auctions/treasury/gp/ (general property, vehicles, vessels, aircraft) and /auctions/treasury/rp/ (real estate). Lots run on contractors: CWS Marketing (AWS WAF; deep links only) and some vehicle sales on HiBid (held on its terms).',
 10, false, false, 60, 20,
 null, 'Seized and forfeited property sold for the Treasury Forfeiture Fund.',
 'https://www.treasury.gov/robots.txt', null),

('irs-auctions', 'IRS Auctions', 'https://www.irsauctions.gov',
 null, 'federal', 'html', null, null,
 false, false, false, false, true,
 'Property seized for unpaid federal taxes. Sale pages at /ad/{slug}, listed in the sitemap. A 2026 sweep reported Akamai 403s; the hourly probe checks from Supabase, and a refusal means deep links only.',
 10, false, false, 60, 30,
 null, 'Property seized by the IRS for unpaid federal taxes.',
 'https://www.irsauctions.gov/robots.txt', null)
on conflict (slug) do nothing;
