-- 0013_hunt_engine.sql
--
-- The engine behind hunts, the watchlist and alerts.
--
-- Until now hunts could be stored but nothing ran them, and the watchlist could
-- hold a walk-away number but nothing reminded anyone. This migration adds:
--
--   run_hunt_matcher()   Matches each active hunt against the live catalogue and
--                        turns new matches into alerts. It honours the tier's
--                        alert latency (tier_limits.alert_latency_seconds): a free
--                        hunt runs at most hourly, a Pro hunt every minute. That
--                        latency is the product difference between tiers, so it
--                        is enforced here, in the database, not in the app.
--   queue_watch_alerts() Closing-soon reminders (the snipe moment), outbid notices
--                        and closed-lot notices for watchlisted lots.
--   run_my_hunt()        What the app calls after a user creates or edits a hunt:
--                        fills that hunt's matches at once, without sending alerts,
--                        so a manual "run now" cannot bypass the tier latency.
--
-- 0014_schedules.sql puts the first two on pg_cron. Everything is set-based SQL
-- inside the database, so none of it depends on an Edge Function's CPU budget.
--
-- ALERT VOLUME. A new hunt for "laptop" can match 30 lots at once. Thirty
-- notifications for one action is how an alert product gets muted, so the first
-- run of a hunt sends one digest, and later runs send at most five individual
-- alerts plus one digest for the rest.
--
-- CHANNELS. Every alert gets an in-app row, which is delivered the moment it is
-- written (the app reads alerts through RLS and realtime). A user who opted into
-- email also gets a separate 'email' row with sent_at null, which the sender
-- function delivers outside quiet hours. Keeping channels as separate rows lets
-- each be retried on its own without re-notifying in the app.

-- ---------------------------------------------------------------- fmt_cents
-- Integer cents to "$1,234.56" for alert text. Numeric division, never a float.
create or replace function public.fmt_cents(p_cents bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_cents is null then null
              else '$' || to_char(p_cents / 100.0, 'FM999,999,999,990.00') end
$$;

-- ---------------------------------------------------------- run_hunt_matcher
create or replace function public.run_hunt_matcher(
  p_max_hunts integer default 200,
  p_only_hunt uuid    default null,
  p_notify    boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h           record;
  v_query     text;
  v_zip       text;
  v_radius    integer;
  v_new       integer;
  v_hunts     integer := 0;
  v_new_total integer := 0;
  v_alerts    integer := 0;
  v_skipped   integer := 0;
  v_first     boolean;
  v_ids       uuid[];
begin
  for h in
    select hu.*,
           coalesce(p.tier, 'free'::user_tier)       as u_tier,
           p.home_postal_code                        as u_zip,
           p.radius_miles                            as u_radius,
           coalesce(p.notify_email, false)           as u_email
      from hunts hu
      join profiles p on p.id = hu.user_id
      left join tier_limits tl on tl.tier = coalesce(p.tier, 'free'::user_tier)
     where hu.active
       and (p_only_hunt is null or hu.id = p_only_hunt)
       -- Tier latency, skipped for a user's own "run now" (which sends no alerts).
       and (p_only_hunt is not null
            or hu.last_run_at is null
            or hu.last_run_at <= now() - make_interval(secs => coalesce(tl.alert_latency_seconds, 3600)))
     order by hu.last_run_at asc nulls first
     limit greatest(coalesce(p_max_hunts, 200), 1)
       for update of hu skip locked
  loop
    v_first := h.last_run_at is null;

    -- The text the catalogue is searched with, in order of preference: the
    -- parser's websearch string, the parsed keywords, the raw text.
    v_query := nullif(btrim(coalesce(
                 nullif(h.parsed ->> 'websearchQuery', ''),
                 nullif(array_to_string(h.keywords, ' '), ''),
                 h.query_text)), '');

    -- A hunt with nothing to match on would match the whole catalogue. Skip it
    -- rather than flood the user; the app requires at least one criterion.
    if v_query is null and cardinality(h.brands) = 0 and cardinality(h.category_ids) = 0
       and h.reference_embedding is null then
      update hunts set last_run_at = now() where id = h.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_zip    := coalesce(nullif(h.postal_code, ''), nullif(h.u_zip, ''));
    v_radius := coalesce(h.radius_miles, h.u_radius, 50);

    with found as (
      select f.lot_id, f.relevance as score, f.distance_miles, f.match_basis as basis
        from search_lots(
               p_query              => v_query,
               p_postal_code        => v_zip,
               p_radius_miles       => v_radius,
               p_include_shippable  => coalesce(h.include_shippable, true),
               p_states             => nullif(h.states, '{}'::text[]),
               p_min_cents          => h.min_price_cents,
               p_max_cents          => h.max_price_cents,
               p_category_ids       => nullif(h.category_ids, '{}'::bigint[]),
               p_tiers              => nullif(h.tiers_only, '{}'::source_tier[]),
               p_closing_within_hours => null,
               p_min_sleeper        => h.min_sleeper_score,
               p_sort               => 'relevance',
               p_limit              => 200,
               p_offset             => 0) f
       where v_query is not null or cardinality(h.brands) > 0 or cardinality(h.category_ids) > 0
      union all
      -- Image hunts: lots whose photos look like the reference photo.
      select m.lot_id, m.similarity, m.distance_miles, 'image'
        from match_lots_by_image(
               p_embedding          => h.reference_embedding,
               p_min_similarity     => coalesce(h.min_similarity, 0.78),
               p_postal_code        => v_zip,
               p_radius_miles       => v_radius,
               p_include_shippable  => coalesce(h.include_shippable, true),
               p_states             => nullif(h.states, '{}'::text[]),
               p_max_cents          => h.max_price_cents,
               p_limit              => 100) m
       where h.reference_embedding is not null
    ), kept as (
      select distinct on (fo.lot_id) fo.*
        from found fo
        join lots l on l.id = fo.lot_id
       where (cardinality(h.sources_only) = 0 or l.source_id = any(h.sources_only))
         and (cardinality(h.brands) = 0 or exists (
               select 1 from unnest(h.brands) b
                where l.brand ilike b
                   or l.title ilike '%' || b || '%'
                   or (numnode(plainto_tsquery('english', b)) > 0
                       and l.search_tsv @@ plainto_tsquery('english', b))))
         -- An excluded word anywhere in the listing disqualifies it.
         and not exists (
               select 1 from unnest(h.exclude_keywords) x
                where numnode(plainto_tsquery('english', x)) > 0
                  and l.search_tsv @@ plainto_tsquery('english', x))
         -- Every required word must appear.
         and not exists (
               select 1 from unnest(h.required_terms) r
                where numnode(plainto_tsquery('english', r)) > 0
                  and not (l.search_tsv @@ plainto_tsquery('english', r)))
         -- Unknown condition passes: most auction listings never state one.
         and (cardinality(h.conditions) = 0 or l.condition is null or l.condition = any(h.conditions))
       order by fo.lot_id, fo.score desc
    ), ins as (
      insert into hunt_matches (hunt_id, lot_id, score, reason, notified_at)
      select h.id, k.lot_id, round(k.score, 4),
             jsonb_build_object('basis', k.basis, 'distance_miles', k.distance_miles, 'query', v_query),
             case when p_notify then now() end
        from kept k
      on conflict (hunt_id, lot_id) do nothing
      returning lot_id, score
    )
    select count(*), coalesce(array_agg(lot_id order by score desc), '{}')
      into v_new, v_ids
      from ins;

    v_new_total := v_new_total + v_new;
    v_hunts := v_hunts + 1;

    if p_notify and h.notify_immediately and v_new > 0 then
      if v_first or v_new > 5 then
        -- One digest: the whole first result set, or the overflow beyond five.
        insert into alerts (user_id, kind, hunt_id, lot_id, channel, title, body, payload, sent_at)
        select h.user_id, 'hunt_digest', h.id, v_ids[1], ch.channel,
               format('Your hunt "%s" found %s lot%s', h.name, v_new, case when v_new = 1 then '' else 's' end),
               case when v_first then 'Here is everything that matches right now. New matches will arrive as they are listed.'
                    else format('%s new matches since the last check.', v_new) end,
               jsonb_build_object('hunt_id', h.id, 'count', v_new, 'lot_ids', to_jsonb(v_ids[1:10])),
               case when ch.channel = 'in_app' then now() end
          from (values ('in_app'), ('email')) ch(channel)
         where ch.channel = 'in_app' or h.u_email;
        get diagnostics v_new = row_count;
        v_alerts := v_alerts + v_new;
      end if;

      if not v_first then
        -- Up to five individual alerts for the strongest new matches.
        insert into alerts (user_id, kind, hunt_id, lot_id, channel, title, body, payload, sent_at)
        select h.user_id, 'hunt_match', h.id, l.id, ch.channel,
               left(l.title, 120),
               concat_ws(' · ',
                 case when l.current_bid_cents is not null then 'Bid ' || fmt_cents(l.current_bid_cents) end,
                 case when l.pickup_city is not null then l.pickup_city || coalesce(', ' || l.pickup_state, '') end,
                 case when l.closes_at is not null then 'closes ' || to_char(l.closes_at at time zone 'America/Chicago', 'Mon DD') end,
                 'hunt: ' || h.name),
               jsonb_build_object('hunt_id', h.id, 'url', l.url, 'image', l.primary_image_url,
                                  'current_bid_cents', l.current_bid_cents, 'closes_at', l.closes_at),
               case when ch.channel = 'in_app' then now() end
          from unnest(v_ids[1:5]) with ordinality u(lot_id, ord)
          join lots l on l.id = u.lot_id
          cross join (values ('in_app'), ('email')) ch(channel)
         where ch.channel = 'in_app' or h.u_email;
        get diagnostics v_new = row_count;
        v_alerts := v_alerts + v_new;
      end if;
    end if;

    update hunts
       set last_run_at = now(),
           match_count = (select count(*) from hunt_matches m where m.hunt_id = h.id and not m.dismissed)
     where id = h.id;
  end loop;

  return jsonb_build_object('hunts', v_hunts, 'new_matches', v_new_total,
                            'alerts', v_alerts, 'skipped_empty', v_skipped);
end $$;

-- ---------------------------------------------------------------- run_my_hunt
-- The app's "run now". Ownership is checked against the caller's JWT; alerts are
-- not sent (the user is looking at the results), so it cannot be used to get
-- faster alerts than the tier allows.
create or replace function public.run_my_hunt(p_hunt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null or not exists (select 1 from hunts where id = p_hunt_id and user_id = auth.uid()) then
    raise exception 'hunt not found' using errcode = 'no_data_found';
  end if;
  return run_hunt_matcher(1, p_hunt_id, false);
end $$;

-- --------------------------------------------------------- queue_watch_alerts
create or replace function public.queue_watch_alerts()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_closing integer := 0;
  v_outbid  integer := 0;
  v_closed  integer := 0;
begin
  -- 1. Closing soon: the snipe moment. For a precise close time, remind
  --    remind_seconds_before ahead (default 10 minutes). GSA publishes only the
  --    close DATE, so a second-level countdown would be a lie; for those lots the
  --    reminder fires at 8:00 on the closing day in the auction's time zone, and
  --    says plainly that the exact time is not published.
  with due as (
    select w.id as watch_id, w.user_id, l.id as lot_id, l.title, l.url, l.closes_at,
           w.max_bid_cents, l.current_bid_cents, l.next_bid_cents, l.primary_image_url,
           coalesce((l.raw -> '_meta' ->> 'closeTimePrecise')::boolean, true) as precise,
           coalesce(a.timezone, 'America/Chicago') as tz,
           p.notify_email
      from watchlist w
      join lots l on l.id = w.lot_id
      join profiles p on p.id = w.user_id
      left join auctions a on a.id = l.auction_id
     where w.reminded_at is null
       and not l.closed
       and l.closes_at is not null
       and l.closes_at > now()
       and case
             when coalesce((l.raw -> '_meta' ->> 'closeTimePrecise')::boolean, true)
               then l.closes_at - make_interval(secs => coalesce(w.remind_seconds_before, 600)) <= now()
             else ((date_trunc('day', l.closes_at at time zone coalesce(a.timezone, 'America/New_York'))
                    + interval '8 hours') at time zone coalesce(a.timezone, 'America/New_York')) <= now()
           end
       for update of w skip locked
  ), ins as (
    insert into alerts (user_id, kind, lot_id, channel, title, body, payload, sent_at)
    select d.user_id, 'closing_soon', d.lot_id, ch.channel,
           'Closing soon: ' || left(d.title, 100),
           concat_ws(' ',
             case when d.precise
                  then format('Closes in about %s minutes.',
                              greatest(1, ceil(extract(epoch from (d.closes_at - now())) / 60))::int)
                  else 'Closes today. The source does not publish the exact time, so place your bid early.' end,
             case when d.max_bid_cents is not null
                  then format('Your walk-away number is %s.', fmt_cents(d.max_bid_cents)) end,
             case when d.current_bid_cents is not null
                  then format('Current bid %s.', fmt_cents(d.current_bid_cents)) end,
             'Enter your one maximum bid on the source site.'),
           jsonb_build_object('url', d.url, 'image', d.primary_image_url, 'closes_at', d.closes_at,
                              'close_time_precise', d.precise, 'max_bid_cents', d.max_bid_cents,
                              'current_bid_cents', d.current_bid_cents, 'next_bid_cents', d.next_bid_cents),
           case when ch.channel = 'in_app' then now() end
      from due d
      cross join (values ('in_app'), ('email')) ch(channel)
     where ch.channel = 'in_app' or coalesce(d.notify_email, false)
    returning 1
  ), marked as (
    update watchlist set reminded_at = now()
     where id in (select watch_id from due)
    returning 1
  )
  select (select count(*) from ins) into v_closing;

  -- 2. Outbid: the visible bid has passed the maximum the user says they placed.
  --    One alert per price level, so a bidding war does not spam.
  insert into alerts (user_id, kind, lot_id, channel, title, body, payload, sent_at)
  select w.user_id, 'outbid', l.id, 'in_app',
         'Outbid: ' || left(l.title, 100),
         format('The current bid is %s, above your %s. Raise it only if your walk-away number allows.',
                fmt_cents(l.current_bid_cents), fmt_cents(w.placed_bid_cents)),
         jsonb_build_object('url', l.url, 'at_cents', l.current_bid_cents,
                            'your_bid_cents', w.placed_bid_cents, 'max_bid_cents', w.max_bid_cents),
         now()
    from watchlist w
    join lots l on l.id = w.lot_id
   where w.placed_bid
     and w.placed_bid_cents is not null
     and l.current_bid_cents is not null
     and l.current_bid_cents > w.placed_bid_cents
     and not l.closed
     and not exists (select 1 from alerts x
                      where x.user_id = w.user_id and x.lot_id = l.id and x.kind = 'outbid'
                        and (x.payload ->> 'at_cents')::bigint >= l.current_bid_cents);
  get diagnostics v_outbid = row_count;

  -- 3. Closed: tell the user once, with the final number, so they can record
  --    the outcome (won, lost, passed). That history is what calibrates future
  --    walk-away numbers.
  insert into alerts (user_id, kind, lot_id, channel, title, body, payload, sent_at)
  select w.user_id, 'lot_sold', l.id, 'in_app',
         'Closed: ' || left(l.title, 100),
         -- format() renders a NULL argument as an empty string, so test for the
         -- price explicitly rather than coalescing the formatted text.
         case when coalesce(l.sold_price_cents, l.current_bid_cents) is not null
              then format('Final price %s.', fmt_cents(coalesce(l.sold_price_cents, l.current_bid_cents)))
              else 'Bidding has ended.' end
           || ' Record whether you won so your numbers improve.',
         jsonb_build_object('url', l.url, 'final_cents', coalesce(l.sold_price_cents, l.current_bid_cents),
                            'your_bid_cents', w.placed_bid_cents, 'max_bid_cents', w.max_bid_cents),
         now()
    from watchlist w
    join lots l on l.id = w.lot_id
   where l.closed
     and w.outcome is null
     and not exists (select 1 from alerts x
                      where x.user_id = w.user_id and x.lot_id = l.id and x.kind = 'lot_sold');
  get diagnostics v_closed = row_count;

  return jsonb_build_object('closing_soon', v_closing, 'outbid', v_outbid, 'closed', v_closed);
end $$;

-- ------------------------------------------------------------ close_expired
-- Lots whose close time has passed stay "open" until their source's next crawl.
-- Close them after a buffer (soft-close extensions run minutes, not hours) so
-- search and hunts never offer a finished auction. A later crawl that still sees
-- the lot live reopens it, because ingest writes `closed` from the source.
create or replace function public.close_expired_lots()
returns integer
language sql
security definer
set search_path = public, extensions
as $$
  with c as (
    update lots set closed = true
     where not closed and closes_at is not null and closes_at < now() - interval '3 hours'
    returning 1
  )
  select count(*)::int from c
$$;

-- ------------------------------------------------------------------ realtime
-- The app subscribes to its own alerts (RLS applies to realtime changes).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alerts') then
    execute 'alter publication supabase_realtime add table public.alerts';
  end if;
end $$;

-- --------------------------------------------------------------- privileges
revoke execute on function public.run_hunt_matcher(integer, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.queue_watch_alerts() from public, anon, authenticated;
revoke execute on function public.close_expired_lots() from public, anon, authenticated;
revoke execute on function public.run_my_hunt(uuid) from public, anon;
grant execute on function public.run_hunt_matcher(integer, uuid, boolean) to service_role;
grant execute on function public.queue_watch_alerts() to service_role;
grant execute on function public.close_expired_lots() to service_role;
grant execute on function public.run_my_hunt(uuid) to authenticated;
