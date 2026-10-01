-- 0044: Finds, the buy finder. A user's goals, and the appraisals it ranks with.
--
-- A goal is what the user is shopping for:
--   resale    profit after every cost, with a minimum profit and return
--   personal  what the user will keep: the saving against buying it elsewhere
--   project   personal use, narrowed to a project's shopping list
-- plus a budget, a radius, a closing window and the sales tax the user pays.
--
-- The app ranks open lots against a goal with the strategy engine
-- (projectAtHammer at today's price, computeMaxBid for the walk-away number),
-- so every figure on a suggestion comes from the same calculator as the lot
-- page. The engine needs a value for each lot, and lot_appraisals holds one: what
-- the lot resells for (low, likely, high), what it costs new, a confidence,
-- where it sells, project tags, a sold-listings search and one line of reasons.
-- The appraise-lots Edge Function writes them with Claude. An appraisal is a
-- fact about the lot, not about a user, so one serves every goal. It is an
-- estimate, and every suggestion says so and links to sold listings to check it.
--
-- appraisal_batches logs every model call (lots, tokens, outcome), so the cost
-- is visible and the daily caps can be counted.
--
-- APPLIED BY HAND with execute_sql, like 0037 to 0043, and recorded in
-- supabase_migrations.schema_migrations with created_by 'execute_sql'.

-- --------------------------------------------------------------------- goals

create table if not exists finder_goals (
  id                   uuid primary key default extensions.gen_random_uuid(),
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                 text not null check (length(btrim(name)) between 1 and 80),
  mode                 text not null default 'resale' check (mode in ('resale', 'personal', 'project')),
  -- What to look for, in plain words, as typed into search.
  focus                text check (length(focus) <= 500),
  -- The most to pay for one lot, all-in: invoice plus the pickup trip.
  budget_cents         bigint check (budget_cents > 0),
  -- resale: the smallest profit, and profit / all-in, worth buying for.
  min_profit_cents     bigint check (min_profit_cents >= 0),
  min_return_pct       numeric check (min_return_pct >= 0 and min_return_pct <= 1000),
  -- null: the profile's home ZIP and radius.
  postal_code          text check (postal_code ~ '^[0-9]{5}$'),
  radius_miles         integer check (radius_miles between 1 and 1000),
  closing_within_hours integer check (closing_within_hours between 1 and 2160),
  include_shippable    boolean not null default true,
  -- 0 with a resale certificate. null: the engine's default.
  sales_tax_pct        numeric check (sales_tax_pct >= 0 and sales_tax_pct <= 20),
  -- Rank on the low estimate instead of the likely one.
  conservative         boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists finder_goals_user on finder_goals (user_id, updated_at desc);

alter table finder_goals enable row level security;

drop policy if exists finder_goals_owner_all on finder_goals;
create policy finder_goals_owner_all on finder_goals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on finder_goals from anon;

create or replace function public.finder_goals_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists finder_goals_touch on finder_goals;
create trigger finder_goals_touch before update on finder_goals
  for each row execute function public.finder_goals_touch();

-- ---------------------------------------------------------------- appraisals

create table if not exists lot_appraisals (
  lot_id              uuid primary key references lots(id) on delete cascade,
  model               text not null,
  -- What the lot is, in a few words.
  item                text not null check (length(item) <= 160),
  resale_low_cents    bigint check (resale_low_cents >= 0),
  resale_likely_cents bigint check (resale_likely_cents >= 0),
  resale_high_cents   bigint check (resale_high_cents >= 0),
  new_price_cents     bigint check (new_price_cents >= 0),
  confidence          text not null check (confidence in ('low', 'medium', 'high')),
  channel             text,
  days_to_sell        integer check (days_to_sell >= 0),
  project_tags        text[] not null default '{}',
  flags               text[] not null default '{}',
  -- Words to search SOLD listings with, to check the estimate.
  comps_query         text check (length(comps_query) <= 160),
  rationale           text check (length(rationale) <= 400),
  -- The lot as it was appraised. A changed title makes the appraisal stale.
  lot_title           text not null,
  bid_cents_at        bigint,
  requested_by        uuid references auth.users(id) on delete set null,
  batch_id            bigint,
  created_at          timestamptz not null default now(),
  check (resale_low_cents is null or resale_likely_cents is null or resale_low_cents <= resale_likely_cents),
  check (resale_likely_cents is null or resale_high_cents is null or resale_likely_cents <= resale_high_cents)
);

alter table lot_appraisals enable row level security;

-- Readable wherever its lot is: the lots policy decides, through the join.
drop policy if exists lot_appraisals_read on lot_appraisals;
create policy lot_appraisals_read on lot_appraisals for select to authenticated
  using (exists (select 1 from lots l where l.id = lot_appraisals.lot_id));

-- Written only by the appraise-lots function (service role). Who asked for an
-- appraisal is not shown to other users.
revoke all on lot_appraisals from anon, authenticated;
grant select (
  lot_id, model, item, resale_low_cents, resale_likely_cents, resale_high_cents, new_price_cents,
  confidence, channel, days_to_sell, project_tags, flags, comps_query, rationale, lot_title,
  bid_cents_at, created_at
) on lot_appraisals to authenticated;

-- ------------------------------------------------------------------- batches

create table if not exists appraisal_batches (
  id                 bigint generated always as identity primary key,
  requested_by       uuid references auth.users(id) on delete set null,
  model              text not null,
  lots               integer not null check (lots >= 0),
  appraised          integer not null default 0 check (appraised >= 0),
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  stop_reason        text,
  error              text,
  created_at         timestamptz not null default now()
);

create index if not exists appraisal_batches_user_day on appraisal_batches (requested_by, created_at desc);
create index if not exists appraisal_batches_day on appraisal_batches (created_at desc);

-- No policy: only the service role reads or writes it.
alter table appraisal_batches enable row level security;
revoke all on appraisal_batches from anon, authenticated;

notify pgrst, 'reload schema';
