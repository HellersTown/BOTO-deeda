-- 0002_core_schema.sql
-- The canonical model. Six design rules are encoded here; breaking any of them
-- is what makes an aggregator rot:
--
--  1. MONEY IS bigint CENTS. Never float. A 13% buyer's premium on $1,234.56
--     must be reproducible to the penny, forever.
--  2. TIME IS timestamptz, PLUS a literal IANA tz string on the auction.
--     Auctioneers publish "closes 6:00 PM" in their own local time. You need the
--     zone to render it honestly and to reason about soft-close extensions.
--  3. LOCATION IS THREE DIFFERENT THINGS: where the item is picked up, where the
--     auction house is, and where the seller is. Conflating them is the single
--     biggest reason "filter by Wisconsin" is broken on every existing site.
--  4. EVERY ROW KEEPS ITS raw jsonb. Re-normalising must never require
--     re-crawling; by then the source may be gone.
--  5. NOTHING IS DELETED. last_seen_at goes stale instead. A lot that vanishes
--     from a source is evidence, not an absence.
--  6. (source_id, external_id) IS UNIQUE. Ingestion is an idempotent upsert, so
--     a crawler that dies mid-run is harmless and safe to replay.

-- ---------------------------------------------------------------- enumerations

do $$ begin
  create type source_tier as enum (
    'federal', 'state', 'county', 'municipal', 'school',
    'private',        -- independent auction house: the small guys nobody indexes
    'estate',         -- estate sale / tag sale companies
    'wholesale',      -- liquidation, customer returns, pallets
    'marketplace',    -- eBay and similar
    'dealer'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type ingest_method as enum (
    'official_api',   -- documented, keyed API. Cheapest and most durable.
    'json_ld',        -- schema.org in <script type="application/ld+json">
    'internal_json',  -- the JSON endpoint the site's own front end already calls
    'rss',
    'sitemap',
    'html',           -- CSS/XPath extraction. Brittle; last resort before JS.
    'headless',       -- real browser. Expensive; only when genuinely forced.
    'deeplink_only',  -- we must NOT ingest; we only construct search URLs
    'manual'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type auction_format as enum ('live','online','hybrid','sealed_bid','fixed_price');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_tier as enum ('free','pro','dealer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type crawl_status as enum ('running','ok','partial','failed','skipped_robots','rate_limited');
exception when duplicate_object then null; end $$;

do $$ begin
  create type alert_kind as enum (
    'hunt_match','closing_soon','outbid','price_drop','new_auction_nearby','lot_sold','hunt_digest'
  );
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------- postal geometry
-- Zip centroids live in our own table so radius search needs no third-party
-- geocoder on the hot path. Seeded from the Census ZCTA gazetteer (public domain).

create table if not exists postal_codes (
  postal_code text primary key,
  city        text,
  state       text not null,
  county      text,
  lat         double precision not null,
  lon         double precision not null,
  geom        extensions.geography(Point, 4326)
                generated always as (
                  extensions.st_setsrid(extensions.st_makepoint(lon, lat), 4326)::extensions.geography
                ) stored,
  population  integer
);
create index if not exists postal_codes_geom_idx  on postal_codes using gist (geom);
create index if not exists postal_codes_state_idx on postal_codes (state);

-- -------------------------------------------------------------------- taxonomy

create table if not exists categories (
  id         bigserial primary key,
  slug       text unique not null,
  label      text not null,
  parent_id  bigint references categories(id) on delete set null,
  -- Terms that map an incoming lot title onto this category. Deliberately DATA,
  -- not code, so classification improves without a deploy.
  match_terms     text[] default '{}',
  negative_terms  text[] default '{}'
);
create index if not exists categories_parent_idx on categories (parent_id);

-- --------------------------------------------------------------------- sources
-- public.sources already existed on this project (0 rows). This migration is
-- strictly additive: it adds columns instead of recreating the table, so nothing
-- referencing the original shape breaks.

create table if not exists sources (
  id   uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  url  text not null
);

alter table sources add column if not exists slug            text;
alter table sources add column if not exists tier            source_tier;
alter table sources add column if not exists ingest          ingest_method;
alter table sources add column if not exists platform        text;   -- hibid | proxibid | auctionmethod | bidwrangler | custom
alter table sources add column if not exists search_template text;
alter table sources add column if not exists description     text;
alter table sources add column if not exists states          text[];
alter table sources add column if not exists has_api         boolean default false;
alter table sources add column if not exists has_rss         boolean default false;
alter table sources add column if not exists verified        boolean default false;
alter table sources add column if not exists active          boolean default true;
alter table sources add column if not exists submitted_by    uuid;
alter table sources add column if not exists approved_by     uuid;
alter table sources add column if not exists created_at      timestamptz default now();

-- Operational / compliance columns.
alter table sources add column if not exists api_base             text;
alter table sources add column if not exists robots_url           text;
alter table sources add column if not exists robots_checked_at    timestamptz;
alter table sources add column if not exists robots_allows        boolean;  -- null = unknown, false = do not crawl
alter table sources add column if not exists terms_url            text;
alter table sources add column if not exists ingest_allowed       boolean default true; -- our call; false => deeplink only
alter table sources add column if not exists ingest_note          text;
alter table sources add column if not exists rate_limit_rpm       integer default 20;
alter table sources add column if not exists requires_js          boolean default false;
alter table sources add column if not exists auth_required        boolean default false;
alter table sources add column if not exists crawl_cadence_min    integer default 60;
alter table sources add column if not exists last_crawled_at      timestamptz;
alter table sources add column if not exists last_ok_at           timestamptz;
alter table sources add column if not exists consecutive_failures integer default 0;
alter table sources add column if not exists priority             integer default 50; -- 0 = crawl first

do $$ begin
  alter table sources add constraint sources_slug_key unique (slug);
exception when duplicate_table then null; when duplicate_object then null; end $$;

create index if not exists sources_active_idx on sources (active, priority) where active;
create index if not exists sources_states_idx on sources using gin (states);

-- -------------------------------------------------------------------- auctions

create table if not exists auctions (
  id          uuid primary key default extensions.gen_random_uuid(),
  source_id   uuid not null references sources(id) on delete cascade,
  external_id text not null,
  title       text not null,
  description text,
  auctioneer  text,
  url         text,
  format      auction_format default 'online',

  starts_at   timestamptz,
  ends_at     timestamptz,
  timezone    text default 'America/Chicago',   -- rule 2

  -- rule 3: pickup is what decides whether a buyer will drive to it.
  pickup_line1       text,
  pickup_city        text,
  pickup_state       text,
  pickup_postal_code text,
  pickup_geom        extensions.geography(Point, 4326),
  pickup_required    boolean default true,

  -- A nationwide online auction that ships is relevant to a Wisconsin buyer even
  -- though it carries no Wisconsin address. This flag is why.
  ships       boolean default false,
  ships_note  text,

  seller_name  text,
  seller_state text,

  lot_count          integer,
  currency           text default 'USD',
  buyer_premium_pct  numeric(5,2),
  buyer_premium_note text,
  terms_url          text,

  raw           jsonb,
  first_seen_at timestamptz default now(),
  last_seen_at  timestamptz default now(),

  constraint auctions_source_external_key unique (source_id, external_id)
);
create index if not exists auctions_ends_at_idx on auctions (ends_at) where ends_at is not null;
create index if not exists auctions_geom_idx    on auctions using gist (pickup_geom);
create index if not exists auctions_state_idx   on auctions (pickup_state);
create index if not exists auctions_source_idx  on auctions (source_id);

-- ------------------------------------------------------------------------ lots

create table if not exists lots (
  id          uuid primary key default extensions.gen_random_uuid(),
  auction_id  uuid references auctions(id) on delete cascade,
  source_id   uuid not null references sources(id) on delete cascade,
  external_id text not null,

  lot_number  text,
  title       text not null,
  description text,
  category_id bigint references categories(id) on delete set null,
  brand       text,
  model       text,
  condition   text,
  quantity    integer default 1,

  -- rule 1: cents, always.
  starting_bid_cents  bigint,
  current_bid_cents   bigint,
  next_bid_cents      bigint,
  estimate_low_cents  bigint,
  estimate_high_cents bigint,
  sold_price_cents    bigint,
  bid_count           integer default 0,
  reserve_met         boolean,

  -- Per-lot close time. Most online auctions stagger closes ("soft close"), so
  -- an auction-level ends_at is not good enough to drive a snipe alert.
  closes_at      timestamptz,
  closed         boolean default false,
  extended_count integer default 0,

  url         text,   -- the deep link the user taps to go bid direct

  -- Usually inherited from the auction, but overridable: some auctions span
  -- several pickup sites, and the lot is the thing you actually drive to.
  pickup_city        text,
  pickup_state       text,
  pickup_postal_code text,
  pickup_geom        extensions.geography(Point, 4326),
  ships              boolean default false,

  primary_image_url text,
  image_urls        text[] default '{}',
  image_count       integer default 0,

  -- Lexical search. Immutable expression, so it can be a stored generated column.
  search_tsv tsvector generated always as (
      setweight(to_tsvector('english', coalesce(title, '')), 'A')
   || setweight(to_tsvector('english', coalesce(brand, '') || ' ' || coalesce(model, '')), 'B')
   || setweight(to_tsvector('english', coalesce(description, '')), 'C')
   || setweight(to_tsvector('english', coalesce(lot_number, '')), 'D')
  ) stored,

  -- Semantic text search over title+description.
  text_embedding   extensions.vector(768),
  text_embed_model text,

  -- The sleeper signal. Components are stored separately so the UI can always
  -- explain WHY a lot was flagged. An unexplainable score gets ignored by users.
  desc_richness   integer,        -- token count of title + description
  sleeper_score   numeric(6,3),
  sleeper_reasons jsonb,

  raw           jsonb,
  first_seen_at timestamptz default now(),
  last_seen_at  timestamptz default now(),
  updated_at    timestamptz default now(),

  constraint lots_source_external_key unique (source_id, external_id)
);

create index if not exists lots_tsv_idx        on lots using gin (search_tsv);
create index if not exists lots_title_trgm_idx on lots using gin (title extensions.gin_trgm_ops);
create index if not exists lots_geom_idx       on lots using gist (pickup_geom);
create index if not exists lots_closes_idx     on lots (closes_at) where closed = false;
create index if not exists lots_state_idx      on lots (pickup_state) where closed = false;
create index if not exists lots_auction_idx    on lots (auction_id);
create index if not exists lots_sleeper_idx    on lots (sleeper_score desc) where closed = false;
create index if not exists lots_category_idx   on lots (category_id) where closed = false;
create index if not exists lots_bid_idx        on lots (current_bid_cents) where closed = false;

-- ------------------------------------------------------------------ lot images
-- Separate table: embeddings are per-image. A coin's reverse is a different
-- vector from its obverse, so one row per photo is the only honest shape.

create table if not exists lot_images (
  id           bigserial primary key,
  lot_id       uuid not null references lots(id) on delete cascade,
  url          text not null,
  storage_path text,
  position     integer default 0,
  width        integer,
  height       integer,

  -- CLIP ViT-L/14 is 768-d: the quality/cost point where fine-grained matching
  -- (a date and mintmark on a coin; whether a drone carries a thermal payload)
  -- starts actually working. embed_model records which model produced the vector
  -- so a future upgrade can backfill deliberately instead of guessing.
  clip_embedding extensions.vector(768),
  embed_model    text,
  embedded_at    timestamptz,

  -- 64-bit perceptual hash. Catches the same photo reused across sources, which
  -- is how you detect relists and dedupe one lot appearing both on an
  -- auctioneer's own site and on their HiBid mirror.
  phash bigint,

  created_at timestamptz default now(),
  constraint lot_images_lot_url_key unique (lot_id, url)
);
create index if not exists lot_images_lot_idx   on lot_images (lot_id);
create index if not exists lot_images_phash_idx on lot_images (phash) where phash is not null;
-- HNSW beats IVFFlat here: the table grows continuously, and IVFFlat would need
-- periodic retraining as it does. Cosine, because CLIP vectors are directional.
create index if not exists lot_images_clip_idx on lot_images
  using hnsw (clip_embedding extensions.vector_cosine_ops);

-- ------------------------------------------------------------ bid intelligence

create table if not exists bid_events (
  id           bigserial primary key,
  lot_id       uuid not null references lots(id) on delete cascade,
  source_id    uuid not null references sources(id) on delete cascade,
  -- The pseudonymous alias the platform itself displays publicly ("Bidder 4821").
  -- Stored to model behaviour. We do NOT attempt to resolve it to a real person.
  bidder_alias text,
  amount_cents bigint not null,
  bid_at       timestamptz,
  is_proxy     boolean,
  observed_at  timestamptz default now(),
  constraint bid_events_dedupe unique (lot_id, bidder_alias, amount_cents, bid_at)
);
create index if not exists bid_events_lot_idx   on bid_events (lot_id, bid_at);
create index if not exists bid_events_rival_idx on bid_events (source_id, bidder_alias);

create table if not exists rivals (
  id           bigserial primary key,
  source_id    uuid not null references sources(id) on delete cascade,
  bidder_alias text not null,
  lots_bid     integer default 0,
  lots_won     integer default 0,
  win_rate     numeric(5,4),
  -- How late they strike. The single most useful number for timing your own bid.
  median_snipe_seconds integer,
  avg_overbid_ratio    numeric(6,3),   -- final bid / low estimate
  top_categories       jsonb,
  first_seen_at timestamptz default now(),
  last_seen_at  timestamptz default now(),
  constraint rivals_key unique (source_id, bidder_alias)
);

-- -------------------------------------------------------------------- accounts

create table if not exists profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text,
  home_postal_code text,
  home_geom        extensions.geography(Point, 4326),
  radius_miles     integer default 50,
  tier             user_tier default 'free',
  timezone         text default 'America/Chicago',
  notify_email     boolean default true,
  notify_push      boolean default true,
  quiet_hours_start smallint,   -- local hour 0-23; null = no quiet hours
  quiet_hours_end   smallint,
  onboarded_at     timestamptz,
  created_at       timestamptz default now()
);

create table if not exists tier_limits (
  tier                  user_tier primary key,
  max_active_hunts      integer,
  max_watchlist         integer,
  image_hunts_allowed   boolean default false,
  rival_intel_allowed   boolean default false,
  alert_latency_seconds integer,   -- how fast we are allowed to tell them
  csv_export_allowed    boolean default false,
  api_access_allowed    boolean default false
);

-- -------------------------------------------------------------------- the hunt
-- A hunt is a STANDING ORDER, not a search box. This is the product's core
-- object: the user describes what they want once, and every newly crawled lot
-- is evaluated against it forever.

create table if not exists hunts (
  id      uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name    text not null,

  query_text text,    -- verbatim, exactly what the human typed
  parsed     jsonb,   -- the structured interpretation, kept for auditability

  keywords         text[]   default '{}',
  exclude_keywords text[]   default '{}',
  category_ids     bigint[] default '{}',
  brands           text[]   default '{}',
  required_terms   text[]   default '{}',   -- "must have thermal"

  min_price_cents bigint,
  max_price_cents bigint,
  conditions      text[] default '{}',

  postal_code       text,
  radius_miles      integer,
  states            text[] default '{}',
  include_shippable boolean default true,   -- the Wisconsin-relevance answer
  sources_only      uuid[] default '{}',
  tiers_only        source_tier[] default '{}',

  -- Image-driven hunt: "find me this, whatever the seller happened to call it."
  reference_image_url text,
  reference_embedding extensions.vector(768),
  min_similarity      numeric(4,3) default 0.780,

  min_sleeper_score numeric(6,3),

  active             boolean default true,
  notify_immediately boolean default true,
  last_run_at        timestamptz,
  match_count        integer default 0,
  created_at         timestamptz default now()
);
create index if not exists hunts_user_idx   on hunts (user_id);
create index if not exists hunts_active_idx on hunts (active) where active;

create table if not exists hunt_matches (
  id          bigserial primary key,
  hunt_id     uuid not null references hunts(id) on delete cascade,
  lot_id      uuid not null references lots(id) on delete cascade,
  score       numeric(6,4),
  reason      jsonb,   -- which clause matched, and how. Always explainable.
  matched_at  timestamptz default now(),
  notified_at timestamptz,
  dismissed   boolean default false,
  constraint hunt_matches_key unique (hunt_id, lot_id)
);
create index if not exists hunt_matches_hunt_idx on hunt_matches (hunt_id, matched_at desc);
create index if not exists hunt_matches_pending_idx on hunt_matches (hunt_id)
  where notified_at is null and dismissed = false;

-- ------------------------------------------------------------------- watchlist

create table if not exists watchlist (
  id      bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  lot_id  uuid not null references lots(id) on delete cascade,
  -- Their private ceiling. Never transmitted anywhere; used only to warn
  -- "this has passed the maximum you set".
  max_bid_cents         bigint,
  notes                 text,
  remind_seconds_before integer default 600,
  reminded_at           timestamptz,
  -- Self-reported, because we cannot see their account on the source platform.
  placed_bid       boolean default false,
  placed_bid_cents bigint,
  outcome          text,   -- won | lost | withdrew | unknown
  created_at       timestamptz default now(),
  constraint watchlist_key unique (user_id, lot_id)
);
create index if not exists watchlist_user_idx   on watchlist (user_id);
create index if not exists watchlist_remind_idx on watchlist (lot_id) where reminded_at is null;

-- ---------------------------------------------------------------------- alerts

create table if not exists alerts (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       alert_kind not null,
  lot_id     uuid references lots(id) on delete set null,
  hunt_id    uuid references hunts(id) on delete set null,
  channel    text,   -- email | push | inapp
  title      text,
  body       text,
  payload    jsonb,
  created_at timestamptz default now(),
  sent_at    timestamptz,
  read_at    timestamptz
);
create index if not exists alerts_user_idx   on alerts (user_id, created_at desc);
create index if not exists alerts_unsent_idx on alerts (created_at) where sent_at is null;

-- ---------------------------------------------------------- crawl observability
-- Without this table you cannot tell "this source has no new lots" from "our
-- parser silently broke three weeks ago". That distinction is the entire
-- difference between a live aggregator and a dead one.

create table if not exists crawl_runs (
  id            bigserial primary key,
  source_id     uuid references sources(id) on delete cascade,
  method        ingest_method,
  status        crawl_status default 'running',
  started_at    timestamptz default now(),
  finished_at   timestamptz,
  http_requests integer default 0,
  auctions_seen integer default 0,
  lots_seen     integer default 0,
  lots_new      integer default 0,
  lots_updated  integer default 0,
  images_queued integer default 0,
  error_text    text,
  errors        jsonb
);
create index if not exists crawl_runs_source_idx on crawl_runs (source_id, started_at desc);

-- A parser that returns rows but the WRONG rows is the dangerous failure mode.
-- Track the expected shape so schema drift is detectable rather than silent.
create table if not exists source_health (
  source_id           uuid primary key references sources(id) on delete cascade,
  median_lots_per_run numeric,
  last_lots_per_run   integer,
  drift_ratio         numeric,   -- last / median; alert below 0.3 or above 3.0
  null_rate_price     numeric,
  null_rate_image     numeric,
  null_rate_close     numeric,
  updated_at          timestamptz default now()
);

create table if not exists ingest_log (
  id         bigserial primary key,
  source_id  uuid references sources(id) on delete set null,
  level      text,
  message    text,
  context    jsonb,
  created_at timestamptz default now()
);
create index if not exists ingest_log_created_idx on ingest_log (created_at desc);
