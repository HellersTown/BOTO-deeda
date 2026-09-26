-- 0004_tiers_metering.sql
-- Meter the thing that actually costs money.
--
-- THE COST MODEL, because it decides the pricing and it is counter-intuitive:
--
-- The naive assumption is that N standing hunts cost N x (new lots per day) in
-- comparisons. At 5,000 hunts and 20,000 new lots a day that is 100,000,000
-- comparisons daily, and the business is dead on arrival.
--
-- That is the wrong direction to run the loop. You do not evaluate each hunt
-- against the lot table. You invert it: each newly ingested lot is run ONCE
-- against an index of hunts. Cost becomes O(new lots), effectively independent
-- of how many hunts exist. A text hunt is therefore close to free, and metering
-- text hunts hard would be metering the wrong thing.
--
-- What genuinely scales with the user's hunt count is VECTOR work:
--
--   1. Embedding every new lot photo (CLIP inference). This is a FIXED platform
--      cost shared by all users -- roughly 20,000 lots/day x 3 photos x
--      $0.0002 = about $12/day. It does not grow per user.
--   2. One HNSW probe per image-hunt per ingest batch. ~2-5 ms against millions
--      of vectors. THIS is the per-user marginal cost, and it is the real reason
--      image hunts belong behind the paywall.
--   3. Vector storage. 768 dims x 4 bytes = 3 KB per photo, and HNSW roughly
--      doubles that. Five million photos is about 35 GB of billable disk.
--
-- So: text hunts are cheap and should be capped only to keep the free tier from
-- being abused as a free API. Image hunts are the expensive privilege. Alert
-- LATENCY is the third lever and costs nothing to give away, which makes it the
-- cleanest upgrade trigger: free users find out on the hourly digest, paid users
-- find out inside a minute. On a lot closing in ten minutes, that gap is the
-- entire product.

alter table tier_limits add column if not exists max_image_hunts    integer default 0;
alter table tier_limits add column if not exists max_sources_watch  integer;
alter table tier_limits add column if not exists price_cents_month  integer;
alter table tier_limits add column if not exists label              text;
alter table tier_limits add column if not exists blurb              text;

-- Free sits at 3 active hunts. Above that is a paid subscription: three is
-- enough to prove the standing-order idea works on something you actually want,
-- and not enough to replace a dealer's watchlist.
update tier_limits set
  label = 'Free',
  max_active_hunts = 3,
  max_image_hunts  = 0,
  max_watchlist    = 25,
  max_sources_watch = null,
  alert_latency_seconds = 3600,
  price_cents_month = 0,
  blurb = 'Three standing hunts, the whole public catalogue, hourly alerts.'
where tier = 'free';

update tier_limits set
  label = 'Pro',
  max_active_hunts = 25,
  max_image_hunts  = 10,
  max_watchlist    = 500,
  max_sources_watch = null,
  alert_latency_seconds = 60,
  price_cents_month = 1200,
  blurb = 'Twenty-five hunts, ten of them photo-matched, alerts inside a minute.'
where tier = 'pro';

update tier_limits set
  label = 'Dealer',
  max_active_hunts = 250,
  max_image_hunts  = 100,
  max_watchlist    = 5000,
  max_sources_watch = null,
  alert_latency_seconds = 30,
  price_cents_month = 4900,
  blurb = 'Volume hunts, full rival intel, CSV export and API access.'
where tier = 'dealer';

-- Image hunts get their own ceiling, enforced in the database for the same
-- reason the total cap is: a limit that lives only in the UI is a suggestion.
create or replace function public.enforce_image_hunt_limit()
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
  -- Only relevant when this row is, in fact, an image hunt.
  if new.reference_embedding is null or not new.active then
    return new;
  end if;

  select coalesce(p.tier, 'free') into v_tier from profiles p where p.id = new.user_id;
  select max_image_hunts into v_max from tier_limits where tier = coalesce(v_tier, 'free');

  if v_max is null then
    return new;
  end if;

  select count(*) into v_count
    from hunts
   where user_id = new.user_id
     and active
     and reference_embedding is not null
     and id <> new.id;

  if v_count >= v_max then
    if v_max = 0 then
      raise exception
        'Photo-matched hunts are a paid feature. The % tier cannot run them.', v_tier
        using errcode = 'check_violation';
    else
      raise exception
        'Photo-hunt limit reached for the % tier (% photo hunts).', v_tier, v_max
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists hunts_enforce_image_limit on hunts;
create trigger hunts_enforce_image_limit
  before insert or update of active, reference_embedding on hunts
  for each row execute function public.enforce_image_hunt_limit();

-- A user-facing view of what they are entitled to and what they have used.
-- The UI should never compute entitlement itself; it reads this.
create or replace view v_my_entitlements
with (security_invoker = true)
as
select
  p.id                       as user_id,
  p.tier,
  tl.label,
  tl.blurb,
  tl.price_cents_month,
  tl.max_active_hunts,
  tl.max_image_hunts,
  tl.max_watchlist,
  tl.alert_latency_seconds,
  tl.image_hunts_allowed,
  tl.rival_intel_allowed,
  tl.csv_export_allowed,
  tl.api_access_allowed,
  (select count(*) from hunts h
    where h.user_id = p.id and h.active)                          as hunts_active,
  (select count(*) from hunts h
    where h.user_id = p.id and h.active
      and h.reference_embedding is not null)                      as image_hunts_active,
  (select count(*) from watchlist w where w.user_id = p.id)       as watchlist_count,
  greatest(tl.max_active_hunts
           - (select count(*) from hunts h where h.user_id = p.id and h.active), 0)
                                                                  as hunts_remaining
from profiles p
join tier_limits tl on tl.tier = p.tier;
