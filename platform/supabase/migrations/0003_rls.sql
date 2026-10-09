-- 0003_rls.sql
-- Row-level security.
--
-- The split that matters: THE CATALOGUE IS PUBLIC, THE USER'S INTENT IS NOT.
--
-- Lots, auctions and sources are world-readable — they are public listings we
-- aggregated, and making them readable without auth is what lets the app show
-- something useful before signup and lets search engines index us.
--
-- A user's hunts, watchlist, private max-bid ceilings and alerts are the
-- opposite. A hunt reveals exactly what someone is about to buy and how much
-- they will pay; leaking it to another bidder on the same platform would be
-- actively harmful to them. Those tables are owner-only, with no exceptions and
-- no "team" escape hatch.
--
-- Writes to the catalogue are service-role only. The crawler runs with the
-- service key; no browser session may ever insert a lot.

alter table sources       enable row level security;
alter table auctions      enable row level security;
alter table lots          enable row level security;
alter table lot_images    enable row level security;
alter table bid_events    enable row level security;
alter table rivals        enable row level security;
alter table categories    enable row level security;
alter table postal_codes  enable row level security;
alter table tier_limits   enable row level security;
alter table profiles      enable row level security;
alter table hunts         enable row level security;
alter table hunt_matches  enable row level security;
alter table watchlist     enable row level security;
alter table alerts        enable row level security;
alter table crawl_runs    enable row level security;
alter table source_health enable row level security;
alter table ingest_log    enable row level security;

-- ------------------------------------------------------- public catalogue reads

do $$
declare t text;
begin
  foreach t in array array['sources','auctions','lots','lot_images',
                           'categories','postal_codes','tier_limits']
  loop
    execute format(
      'drop policy if exists %I on %I', t || '_public_read', t);
    execute format(
      'create policy %I on %I for select to anon, authenticated using (true)',
      t || '_public_read', t);
  end loop;
end $$;

-- ------------------------------------------------- rival intel is a paid feature
-- bid_events and rivals are deliberately NOT in the loop above. Rival
-- intelligence is sold on the pro tier, and a paywall that exists only in the UI
-- is not a paywall — anyone with the anon key could read the table directly.
-- So the entitlement is enforced here, against the user's own tier row.

create or replace function public.has_rival_intel()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select tl.rival_intel_allowed
       from profiles p
       join tier_limits tl on tl.tier = p.tier
      where p.id = auth.uid()),
    false)
$$;

drop policy if exists bid_events_paid_read on bid_events;
create policy bid_events_paid_read on bid_events
  for select to authenticated using (public.has_rival_intel());

drop policy if exists rivals_paid_read on rivals;
create policy rivals_paid_read on rivals
  for select to authenticated using (public.has_rival_intel());

-- Only `sources` accepts a community submission, and only from a signed-in user,
-- and only as unverified/inactive. Everything else about a source is ours.
drop policy if exists sources_user_submit on sources;
create policy sources_user_submit on sources
  for insert to authenticated
  with check (
    submitted_by = auth.uid()
    and coalesce(verified, false) = false
    and coalesce(active,   true)  = false
  );

-- ------------------------------------------------------------- owner-only data

-- profiles: a user sees and edits exactly their own row.
drop policy if exists profiles_self_select on profiles;
create policy profiles_self_select on profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_self_insert on profiles;
create policy profiles_self_insert on profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- hunts / watchlist / alerts: full CRUD, scoped to the owner.
do $$
declare t text;
begin
  foreach t in array array['hunts','watchlist','alerts']
  loop
    execute format('drop policy if exists %I on %I', t || '_owner_all', t);
    execute format(
      'create policy %I on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_owner_all', t);
  end loop;
end $$;

-- hunt_matches has no user_id of its own; ownership is inherited through the hunt.
drop policy if exists hunt_matches_owner_all on hunt_matches;
create policy hunt_matches_owner_all on hunt_matches
  for all to authenticated
  using      (exists (select 1 from hunts h where h.id = hunt_matches.hunt_id and h.user_id = auth.uid()))
  with check (exists (select 1 from hunts h where h.id = hunt_matches.hunt_id and h.user_id = auth.uid()));

-- ------------------------------------------------------------------- internals
-- crawl_runs, source_health and ingest_log carry operational detail (failure
-- messages, request counts, parser internals). No policy is created for them, so
-- with RLS enabled they are unreachable by anon and authenticated, and remain
-- fully readable by the service role, which bypasses RLS by design. That is the
-- intent: an ops table with no policy is a locked table, not an oversight.

-- ------------------------------------------- profile bootstrap on signup
-- Without this, a new user has no profile row and every screen has to special-case
-- null. The trigger runs as the definer so it can insert past RLS.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------- tier defaults
-- The free tier is deliberately generous on READING and strict on STANDING
-- ORDERS. Reading costs us almost nothing; a hunt costs us a similarity query
-- against every new lot forever, so that is the thing to meter.
--
-- alert_latency_seconds is the honest paid differentiator: free users learn about
-- a match on the next digest, paid users learn within a minute. On a lot closing
-- in ten minutes that difference is the entire product.

insert into tier_limits (tier, max_active_hunts, max_watchlist, image_hunts_allowed,
                         rival_intel_allowed, alert_latency_seconds,
                         csv_export_allowed, api_access_allowed)
values
  ('free',    3,   25, false, false, 3600, false, false),
  ('pro',    50,  500, true,  true,    60, true,  false),
  ('dealer', 500, 5000, true, true,    30, true,  true)
on conflict (tier) do update set
  max_active_hunts      = excluded.max_active_hunts,
  max_watchlist         = excluded.max_watchlist,
  image_hunts_allowed   = excluded.image_hunts_allowed,
  rival_intel_allowed   = excluded.rival_intel_allowed,
  alert_latency_seconds = excluded.alert_latency_seconds,
  csv_export_allowed    = excluded.csv_export_allowed,
  api_access_allowed    = excluded.api_access_allowed;

-- Enforce the hunt cap in the database, not only in the UI. A client-side limit
-- is a suggestion; this is a rule.
create or replace function public.enforce_hunt_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier  user_tier;
  v_max   integer;
  v_count integer;
begin
  select coalesce(p.tier, 'free') into v_tier from profiles p where p.id = new.user_id;
  select max_active_hunts into v_max from tier_limits where tier = coalesce(v_tier, 'free');
  if v_max is null then
    return new;
  end if;
  select count(*) into v_count from hunts
   where user_id = new.user_id and active
     and (new.id is null or id <> new.id);
  if new.active and v_count >= v_max then
    raise exception
      'Hunt limit reached for the % tier (% active hunts). Pause one, or upgrade.',
      v_tier, v_max
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists hunts_enforce_limit on hunts;
create trigger hunts_enforce_limit
  before insert or update of active on hunts
  for each row execute function public.enforce_hunt_limit();
