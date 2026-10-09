-- 0025: AuctionGuide goes live as sale-level rows (0023), and the watch
-- reminder speaks to a sale as a sale.
--
-- AuctionGuide publishes no terms; its robots.txt content signals allow search
-- use (links and short excerpts; docs/08 section 1a). One page per state holds
-- the state's whole list: 31 Wisconsin sales on 2026-09-30, read in one request
-- plus robots.txt. The adapter keeps city, state and ZIP (never the street or
-- coordinates), a 300-character excerpt, and no images: most of the site's
-- thumbnails are HiBid's.

update sources
   set platform          = 'auctionguide',
       url               = 'https://www.auctionguide.com',
       robots_url        = 'https://www.auctionguide.com/robots.txt',
       states            = array['WI'],
       rate_limit_rpm    = 10,
       crawl_cadence_min = 60,
       ingest            = 'html'
 where slug = 'auctionguide';

-- The closing-soon reminder ended every message with "Enter your one maximum
-- bid on the source site." For a watched sale that is the wrong instruction:
-- the sale has many lots and no single price. Patched in place, as in 0018.
do $$
declare
  d text;
  n integer;
begin
  d := pg_get_functiondef('public.queue_watch_alerts()'::regprocedure);
  if position('d.sale_level' in d) = 0 then
    n := (length(d) - length(replace(d, 'l.next_bid_cents, l.primary_image_url,', '')))
         / length('l.next_bid_cents, l.primary_image_url,');
    if n <> 1 then raise exception 'queue_watch_alerts: due select list found % times', n; end if;
    d := replace(d, 'l.next_bid_cents, l.primary_image_url,', 'l.next_bid_cents, l.primary_image_url, l.sale_level,');

    n := (length(d) - length(replace(d, '''Enter your one maximum bid on the source site.'')', '')))
         / length('''Enter your one maximum bid on the source site.'')');
    if n <> 1 then raise exception 'queue_watch_alerts: closing sentence found % times', n; end if;
    d := replace(d, '''Enter your one maximum bid on the source site.'')',
                    'case when d.sale_level then ''Open the sale to see its lots; bidding happens on the source site.'''
                    || ' else ''Enter your one maximum bid on the source site.'' end)');
    execute d;
  end if;
end $$;
