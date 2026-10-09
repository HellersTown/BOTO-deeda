-- 0009_column_privileges.sql
--
-- BUG 6 — CRITICAL. A privilege escalation, found by acting as a signed-in user.
--
-- Reproduced exactly as a browser client would, through RLS:
--
--     set role authenticated;  set request.jwt.claims = '{"sub": <user>}';
--     update profiles set tier = 'dealer' where id = auth.uid();
--     -> before: tier=free    after: tier=dealer    (SUCCEEDED)
--
-- Any user could grant themselves the $49/month Dealer tier — 250 hunts, 100
-- photo hunts, API access, full rival intel — from the browser devtools console.
--
-- WHY, stated plainly because it contradicts something claimed earlier:
--
-- 0003 described the rival-intel paywall as "enforced in the database, not the
-- UI, because anyone with the anon key can bypass a UI check." has_rival_intel()
-- does read the tier from the database. But the user could WRITE that tier. A
-- database-enforced check is only as strong as its input, and here the input was
-- user-controlled. The claim was false as shipped.
--
-- Root cause: Postgres row-level security restricts ROWS, not COLUMNS.
-- profiles_self_update correctly confined each user to their own row, and then
-- let them change every column on it. Supabase also grants table-wide UPDATE to
-- the `authenticated` role by default, so nothing else stood in the way.
--
-- Fix: column-level privileges. Revoke the table-wide write, then grant back only
-- the columns a user may legitimately edit. `tier` becomes writable by the
-- service role alone — i.e. by the billing webhook, never by the client.
--
-- ORDER MATTERS: in Postgres a table-level UPDATE grant makes column-level
-- revokes ineffective, so the table grant must be revoked first and the column
-- grants added back after.
--
-- The same root cause appeared in three more places, fixed here too:
--
--   sources   A community submission could set robots_allows = true,
--             ingest_allowed = true and rate_limit_rpm = 100000. The RLS check
--             only pinned verified/active. An admin who then flipped active=true
--             without reading every column would launch a crawl that skips the
--             robots check and hammers the target — the exact failure the whole
--             politeness design exists to prevent.
--   alerts    Users could INSERT alerts for themselves with arbitrary title/body,
--             which the sender then emails. Self-only, so low severity, but alerts
--             are system output and users should only mark them read.
--   hunt_matches  Users could fabricate matches. Same reasoning: system output.
--
-- And one cost-abuse guard:
--
--   hunts.min_similarity  A photo hunt with min_similarity = 0 matches every
--             image in the catalogue. That is the expensive operation the tiers
--             meter, so the threshold is bounded.

-- ------------------------------------------------------------------- profiles

revoke insert, update on profiles from anon, authenticated;

-- Everything a user may edit about themselves. Deliberately ABSENT: id, tier,
-- created_at. The tier is a billing fact, not a preference.
grant update (
  display_name, home_postal_code, home_geom, radius_miles, timezone,
  notify_email, notify_push, quiet_hours_start, quiet_hours_end, onboarded_at
) on profiles to authenticated;

-- Profiles are created by the on_auth_user_created trigger, which runs as the
-- definer. Clients never need to insert one, and allowing it would let a client
-- race the trigger with a chosen tier. So no insert grant is restored.

drop policy if exists profiles_self_insert on profiles;

-- -------------------------------------------------------------------- sources

revoke insert, update on sources from anon, authenticated;

-- A submission carries only what a member of the public can know.
grant insert (name, url, description, states, submitted_by)
  on sources to authenticated;

-- An earlier draft of this migration pinned the safe values in the RLS policy
-- (active = false, and so on) while ALSO withholding those columns from the
-- grant. That combination rejects every legitimate submission: a column the
-- client cannot set takes its default, sources.active defaults to TRUE, and the
-- policy then demands FALSE. Caught by re-reading before applying.
--
-- The robust shape is not to rely on the client sending safe values at all, but
-- to overwrite them server-side. Any row carrying submitted_by is a community
-- submission, and is forced into the fully-unapproved state regardless of what
-- was sent. Seed and admin rows have submitted_by = NULL and are untouched.
create or replace function public.quarantine_community_source()
returns trigger
language plpgsql
as $$
begin
  if new.submitted_by is not null then
    new.active            := false;   -- not crawled
    new.verified          := false;   -- not reviewed
    new.robots_allows     := null;    -- null means DO NOT CRAWL to the crawler
    new.ingest_allowed    := false;   -- no legal determination yet
    new.approved_by       := null;
    new.rate_limit_rpm    := 20;      -- the conservative default, never a user's
    new.priority          := 90;      -- back of the queue
    new.crawl_cadence_min := 60;
  end if;
  return new;
end $$;

drop trigger if exists sources_quarantine_submissions on sources;
create trigger sources_quarantine_submissions
  before insert on sources
  for each row execute function public.quarantine_community_source();

drop policy if exists sources_user_submit on sources;
create policy sources_user_submit on sources
  for insert to authenticated
  with check (submitted_by = auth.uid());

-- ------------------------------------------------------------------- alerts

revoke insert, update on alerts from anon, authenticated;
grant update (read_at) on alerts to authenticated;

-- ------------------------------------------------------------- hunt_matches

revoke insert, update on hunt_matches from anon, authenticated;
grant update (dismissed) on hunt_matches to authenticated;

-- -------------------------------------------------------------------- hunts
-- Users legitimately create and edit hunts, so the table grant stays. The guard
-- here is a bound on the one parameter that turns a hunt into a cost weapon.

alter table hunts drop constraint if exists hunts_min_similarity_bounds;
alter table hunts add constraint hunts_min_similarity_bounds
  check (min_similarity is null or (min_similarity >= 0.60 and min_similarity <= 1.00));

-- match_count and last_run_at are bookkeeping written by the hunt runner. A user
-- editing them is harmless to anyone else but misleading, so they are withheld.
revoke update on hunts from anon, authenticated;
grant update (
  name, query_text, parsed, keywords, exclude_keywords, category_ids, brands,
  required_terms, min_price_cents, max_price_cents, conditions, postal_code,
  radius_miles, states, include_shippable, sources_only, tiers_only,
  reference_image_url, reference_embedding, min_similarity, min_sleeper_score,
  active, notify_immediately
) on hunts to authenticated;
