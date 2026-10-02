-- 0008_downgrade_reconciliation.sql
--
-- BUG 5, and the most commercially serious one found by testing.
--
-- Observed: a user who created 10 photo hunts on Pro and was then moved back to
-- Free kept all 10 running. v_my_entitlements reported:
--
--     tier=free  active=10  image=10  remaining=0
--
-- on a tier that permits 3 text hunts and ZERO photo hunts.
--
-- Why: the limit triggers from 0003/0004 fire on hunts INSERT and on hunts
-- UPDATE OF active / reference_embedding. Changing the tier on the PROFILE row
-- touches no hunt, so nothing re-checks. Every individual guard was correct;
-- the gap was that the one event which changes a user's limits was not guarded
-- at all.
--
-- The exploit is trivial and it targets exactly the thing the pricing is built
-- on: subscribe to Pro for one month, create ten photo hunts, cancel, and keep
-- all ten running free indefinitely. Photo hunts are the per-user vector work
-- that makes Pro cost money to serve.
--
-- Fix: whenever a profile's tier changes, reconcile that user's hunts against
-- the NEW limits. It runs on every tier change rather than only on "downgrades",
-- which avoids having to rank tiers and stays correct if tiers are added or
-- reordered later.
--
-- Policy for WHICH hunts survive: keep the oldest, pause the newest. The oldest
-- hunts are the ones a user has been relying on longest, and "your most recently
-- added hunts were paused" is easy to explain and easy to undo by hand. Photo
-- hunts are reconciled first because they carry their own, tighter cap.
--
-- Hunts are PAUSED, never deleted. A user who re-subscribes gets them back with a
-- click, and nothing they built is lost.

alter table hunts add column if not exists paused_reason text;
alter table hunts add column if not exists paused_at     timestamptz;

comment on column hunts.paused_reason is
  'Why the system paused this hunt, shown to the user. NULL when active, or when the user paused it themselves.';

create or replace function public.reconcile_hunts_to_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_hunts  integer;
  v_max_images integer;
  v_label      text;
begin
  if new.tier is not distinct from old.tier then
    return new;
  end if;

  select max_active_hunts, max_image_hunts, coalesce(label, new.tier::text)
    into v_max_hunts, v_max_images, v_label
    from tier_limits
   where tier = new.tier;

  -- 1. Photo hunts first: they carry their own cap and are the expensive kind.
  if v_max_images is not null then
    update hunts h
       set active        = false,
           paused_at     = now(),
           paused_reason = format(
             'Paused when your plan changed to %s, which allows %s photo-matched hunt(s). '
             'Upgrade, or pause another photo hunt, to turn this back on.',
             v_label, v_max_images)
     where h.id in (
       select id from hunts
        where user_id = new.id
          and active
          and reference_embedding is not null
        order by created_at asc, id asc
       offset v_max_images
     );
  end if;

  -- 2. Then the overall cap, counting whatever survived step 1.
  if v_max_hunts is not null then
    update hunts h
       set active        = false,
           paused_at     = now(),
           paused_reason = format(
             'Paused when your plan changed to %s, which allows %s active hunt(s). '
             'Upgrade, or pause another hunt, to turn this back on.',
             v_label, v_max_hunts)
     where h.id in (
       select id from hunts
        where user_id = new.id
          and active
        order by created_at asc, id asc
       offset v_max_hunts
     );
  end if;

  return new;
end $$;

comment on function public.reconcile_hunts_to_tier is
  'On any tier change, pauses the newest hunts beyond the new plan''s limits (photo hunts first). Closes the subscribe-create-cancel bypass. Pauses, never deletes.';

drop trigger if exists profiles_reconcile_tier on profiles;
create trigger profiles_reconcile_tier
  after update of tier on profiles
  for each row execute function public.reconcile_hunts_to_tier();

-- A user re-activating a hunt that the system paused should clear the reason, so
-- a stale "paused because you downgraded" message never sits on an active hunt.
create or replace function public.clear_pause_reason()
returns trigger
language plpgsql
as $$
begin
  if new.active and not old.active then
    new.paused_reason := null;
    new.paused_at     := null;
  end if;
  return new;
end $$;

drop trigger if exists hunts_clear_pause_reason on hunts;
create trigger hunts_clear_pause_reason
  before update of active on hunts
  for each row execute function public.clear_pause_reason();
