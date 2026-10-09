-- 0023: sale-level rows.
--
-- Some sources list SALES, not lots: AuctionGuide's Wisconsin directory (31
-- current auctions on 2026-09-30, each "421 lots, Greenleaf, WI, ends today"),
-- and Wisconsin Surplus's public auction list. Search is lot-based, so until
-- now such a source was invisible to search and hunts. A sale-level row is one
-- `lots` row that stands for a whole sale: its title and description are the
-- sale's own (often a list of what is in it: "Snap On, Matco, woodworking"),
-- its close is the sale's close, and its link goes to the sale. It has no price
-- and no bid count, and it gets no sleeper score, which describes single lots.
--
-- With it, a hunt for "tractor" can say "a sale 40 miles away lists tractors",
-- which is exactly the discovery these sources are for.
--
-- 1. lots.sale_level.
-- 2. ingest_batch reads "saleLevel" from each lot and leaves the sleeper score
--    empty for sale-level rows.
-- 3. refresh_sleeper_scores skips them.
-- 4. search_lots returns sale_level and the sale's lot count, so the app can
--    draw a sale card instead of a lot card.
--
-- Functions are edited from their live definitions, one exact replacement at a
-- time, as in 0018. If any expected text is missing, nothing changes.

alter table lots add column if not exists sale_level boolean not null default false;
comment on column lots.sale_level is
  'True when the row stands for a whole sale (a source that lists sales, not lots). No price, bid count or sleeper score; the link goes to the sale.';

do $$
declare
  d text;
  n integer;  -- how many times an expected text occurs; each must occur once
begin
  -- ------------------------------------------------------------ ingest_batch
  d := pg_get_functiondef('public.ingest_batch(bigint, jsonb, jsonb)'::regprocedure);

  if position('"saleLevel"' in d) = 0 then
    n := (length(d) - length(replace(d, 'closed boolean, url text, pickup jsonb, ships boolean, images jsonb, raw jsonb)', '')))
         / length('closed boolean, url text, pickup jsonb, ships boolean, images jsonb, raw jsonb)');
    if n <> 1 then raise exception 'ingest_batch: lot record definition found % times', n; end if;
    d := replace(d, 'closed boolean, url text, pickup jsonb, ships boolean, images jsonb, raw jsonb)',
                    'closed boolean, url text, pickup jsonb, ships boolean, images jsonb, raw jsonb, "saleLevel" boolean)');

    n := (length(d) - length(replace(d, 'raw, last_seen_at, updated_at)', ''))) / length('raw, last_seen_at, updated_at)');
    if n <> 1 then raise exception 'ingest_batch: lot insert column list found % times', n; end if;
    d := replace(d, 'raw, last_seen_at, updated_at)', 'raw, last_seen_at, updated_at, sale_level)');

    n := (length(d) - length(replace(d, E'r.raw, now(), now()\n', ''))) / length(E'r.raw, now(), now()\n');
    if n <> 1 then raise exception 'ingest_batch: lot insert values found % times', n; end if;
    d := replace(d, E'r.raw, now(), now()\n', E'r.raw, now(), now(), coalesce(r."saleLevel", false)\n');

    -- A sale-level row describes a whole sale: no sleeper score.
    n := (length(d) - length(replace(d, E'(sc.s ->> ''score'')::numeric, sc.s -> ''reasons'',', '')))
         / length(E'(sc.s ->> ''score'')::numeric, sc.s -> ''reasons'',');
    if n <> 1 then raise exception 'ingest_batch: sleeper values found % times', n; end if;
    d := replace(d, E'(sc.s ->> ''score'')::numeric, sc.s -> ''reasons'',',
                    E'case when coalesce(r."saleLevel", false) then null else (sc.s ->> ''score'')::numeric end,\n' ||
                    E'      case when coalesce(r."saleLevel", false) then null else sc.s -> ''reasons'' end,');

    n := (length(d) - length(replace(d, E'      last_seen_at        = now(),\n      updated_at = case', '')))
         / length(E'      last_seen_at        = now(),\n      updated_at = case');
    if n <> 1 then raise exception 'ingest_batch: lot conflict update found % times', n; end if;
    d := replace(d, E'      last_seen_at        = now(),\n      updated_at = case',
                    E'      sale_level          = excluded.sale_level,\n      last_seen_at        = now(),\n      updated_at = case');
    execute d;
  end if;

  -- -------------------------------------------------- refresh_sleeper_scores
  d := pg_get_functiondef('public.refresh_sleeper_scores(integer)'::regprocedure);
  if position('not sale_level' in d) = 0 then
    n := (length(d) - length(replace(d, E'    select id from lots\n     where closed = false\n', '')))
         / length(E'    select id from lots\n     where closed = false\n');
    if n <> 1 then raise exception 'refresh_sleeper_scores: target found % times', n; end if;
    d := replace(d, E'    select id from lots\n     where closed = false\n',
                    E'    select id from lots\n     where closed = false and not sale_level\n');
    execute d;
  end if;

  -- --------------------------------------------------------------- search_lots
  d := pg_get_functiondef('public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text)'::regprocedure);
  if position('sale_level boolean' in d) = 0 then
    d := replace(d, 'match_basis text, pickup_geo_source text)',
                    'match_basis text, pickup_geo_source text, sale_level boolean, sale_lot_count integer)');
    d := replace(d, E'    select l.*, a.title as a_title, a.auctioneer as a_auctioneer,\n',
                    E'    select l.*, a.title as a_title, a.auctioneer as a_auctioneer, a.lot_count as a_lot_count,\n');
    d := replace(d, E'         sc.pickup_geo_source\n    from scored sc',
                    E'         sc.pickup_geo_source,\n         sc.sale_level,\n         sc.a_lot_count\n    from scored sc');
    if position('sale_level boolean, sale_lot_count integer)' in d) = 0
       or position('a.lot_count as a_lot_count' in d) = 0
       or position('sc.a_lot_count' in d) = 0 then
      raise exception 'search_lots did not match the expected definition; nothing changed';
    end if;
    drop function public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text);
    execute d;
  end if;
end $$;

grant execute on function public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text)
  to anon, authenticated, service_role;

comment on function public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text) is
  'Location-first lot search. p_tsquery (the parser''s grouped query) is preferred over p_query when it parses. Returns pickup_geo_source so callers can mark approximate distances, and sale_level (with the sale''s lot count) for rows that stand for a whole sale. Only sources that are active and permitted are searched.';

notify pgrst, 'reload schema';
