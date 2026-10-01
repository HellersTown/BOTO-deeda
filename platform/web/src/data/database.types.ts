/**
 * The public schema as the browser sees it, hand-written from
 * platform/supabase/migrations (0002 tables, 0004 and 0010 views, 0005/0006
 * search_lots, 0013 run_my_hunt, 0016 pickup_geo_source, 0018 p_tsquery,
 * 0023 sale-level rows) in the shape `supabase gen types` produces.
 *
 * Two things are encoded here on purpose, so the compiler enforces the
 * backend's rules instead of the reviewer:
 *
 *   - Update types list ONLY the columns 0009_column_privileges.sql grants to
 *     `authenticated`. profiles.tier, hunts.match_count/last_run_at and every
 *     alerts column but read_at are absent, so writing them does not compile.
 *   - Insert is `never` for tables the client may not insert into (profiles,
 *     alerts, hunt_matches: 0009 revokes insert; the catalogue is service-role
 *     only per 0003).
 *
 * Money is integer cents (bigint in Postgres, number here; every value the
 * catalogue holds is far below 2^53). Timestamps are ISO-8601 strings with an
 * offset, as PostgREST returns timestamptz.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type SourceTier =
  | 'federal'
  | 'state'
  | 'county'
  | 'municipal'
  | 'school'
  | 'private'
  | 'estate'
  | 'wholesale'
  | 'marketplace'
  | 'dealer';
export type IngestMethod =
  | 'official_api'
  | 'json_ld'
  | 'internal_json'
  | 'rss'
  | 'sitemap'
  | 'html'
  | 'headless'
  | 'deeplink_only'
  | 'manual';
export type AuctionFormat = 'live' | 'online' | 'hybrid' | 'sealed_bid' | 'fixed_price';
export type UserTier = 'free' | 'pro' | 'dealer';
export type AlertKind =
  | 'hunt_match'
  | 'closing_soon'
  | 'outbid'
  | 'price_drop'
  | 'new_auction_nearby'
  | 'lot_sold'
  | 'hunt_digest';
export type SearchSort = 'relevance' | 'closing' | 'nearest' | 'cheapest' | 'sleeper' | 'newest';
export type MatchBasis = 'nearby' | 'in_state' | 'ships_to_you' | 'other';

/**
 * How a pickup point was found (0016): coordinates the source published, the
 * ZIP's centroid, or the city's centroid. A distance to a 'city' point is
 * approximate.
 */
export type PickupGeoSource = 'source' | 'postal_code' | 'city';

/** Values of sources.access_status (0010 check constraint). */
export type AccessStatus = 'open' | 'blocked' | 'robots_disallowed' | 'unreachable' | 'deeplink_only' | 'unknown';

// ------------------------------------------------------------------ catalogue

export type SourceRow = {
  id: string;
  name: string;
  url: string;
  slug: string | null;
  tier: SourceTier | null;
  ingest: IngestMethod | null;
  platform: string | null;
  description: string | null;
  states: string[] | null;
  active: boolean | null;
  access_status: AccessStatus | null;
  last_ok_at: string | null;
}

export type AuctionRow = {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  description: string | null;
  auctioneer: string | null;
  url: string | null;
  format: AuctionFormat | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  pickup_line1: string | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  pickup_required: boolean | null;
  pickup_geo_source: PickupGeoSource | null;
  ships: boolean | null;
  ships_note: string | null;
  seller_name: string | null;
  seller_state: string | null;
  lot_count: number | null;
  currency: string | null;
  buyer_premium_pct: number | null;
  buyer_premium_note: string | null;
  terms_url: string | null;
  raw: Json | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export type LotRow = {
  id: string;
  auction_id: string | null;
  source_id: string;
  external_id: string;
  lot_number: string | null;
  title: string;
  description: string | null;
  category_id: number | null;
  brand: string | null;
  model: string | null;
  condition: string | null;
  quantity: number | null;
  starting_bid_cents: number | null;
  current_bid_cents: number | null;
  next_bid_cents: number | null;
  estimate_low_cents: number | null;
  estimate_high_cents: number | null;
  sold_price_cents: number | null;
  bid_count: number | null;
  reserve_met: boolean | null;
  closes_at: string | null;
  closed: boolean | null;
  extended_count: number | null;
  url: string | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  pickup_geo_source: PickupGeoSource | null;
  ships: boolean | null;
  primary_image_url: string | null;
  image_urls: string[] | null;
  image_count: number | null;
  desc_richness: number | null;
  sleeper_score: number | null;
  sleeper_reasons: Json | null;
  raw: Json | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  updated_at: string | null;
  /**
   * 0023: the row stands for a whole sale, from a source that lists sales
   * rather than lots. Its title, description, close and url are the sale's;
   * it has no price, bid count or sleeper score. Not null, default false.
   */
  sale_level: boolean;
}

export type LotImageRow = {
  id: number;
  lot_id: string;
  url: string;
  position: number | null;
  width: number | null;
  height: number | null;
}

export type CategoryRow = {
  id: number;
  slug: string;
  label: string;
  parent_id: number | null;
}

export type PostalCodeRow = {
  postal_code: string;
  city: string | null;
  state: string;
  county: string | null;
  lat: number;
  lon: number;
  population: number | null;
  source: string | null;
}

export type TierLimitsRow = {
  tier: UserTier;
  label: string | null;
  blurb: string | null;
  price_cents_month: number | null;
  max_active_hunts: number | null;
  max_image_hunts: number | null;
  max_watchlist: number | null;
  alert_latency_seconds: number | null;
  image_hunts_allowed: boolean | null;
  rival_intel_allowed: boolean | null;
  csv_export_allowed: boolean | null;
  api_access_allowed: boolean | null;
}

// --------------------------------------------------------------- owner data

export type ProfileRow = {
  id: string;
  display_name: string | null;
  home_postal_code: string | null;
  radius_miles: number | null;
  tier: UserTier | null;
  timezone: string | null;
  notify_email: boolean | null;
  notify_push: boolean | null;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  onboarded_at: string | null;
  created_at: string | null;
}

/** 0009: the only profile columns `authenticated` may update (home_geom is also granted; the app does not write it). */
export type ProfileUpdate = {
  display_name?: string | null;
  home_postal_code?: string | null;
  radius_miles?: number | null;
  timezone?: string | null;
  notify_email?: boolean | null;
  notify_push?: boolean | null;
  quiet_hours_start?: number | null;
  quiet_hours_end?: number | null;
  onboarded_at?: string | null;
}

export type HuntRow = {
  id: string;
  user_id: string;
  name: string;
  query_text: string | null;
  parsed: Json | null;
  keywords: string[];
  exclude_keywords: string[];
  category_ids: number[];
  brands: string[];
  required_terms: string[];
  min_price_cents: number | null;
  max_price_cents: number | null;
  conditions: string[];
  postal_code: string | null;
  radius_miles: number | null;
  states: string[];
  include_shippable: boolean | null;
  sources_only: string[];
  tiers_only: SourceTier[];
  reference_image_url: string | null;
  min_similarity: number | null;
  min_sleeper_score: number | null;
  active: boolean;
  notify_immediately: boolean;
  last_run_at: string | null;
  match_count: number;
  created_at: string;
  paused_reason: string | null;
  paused_at: string | null;
}

/** hunts keeps its table-level INSERT grant (0009 revokes only UPDATE). */
export type HuntInsert = {
  user_id: string;
  name: string;
  query_text?: string | null;
  parsed?: Json | null;
  keywords?: string[];
  exclude_keywords?: string[];
  category_ids?: number[];
  brands?: string[];
  required_terms?: string[];
  min_price_cents?: number | null;
  max_price_cents?: number | null;
  conditions?: string[];
  postal_code?: string | null;
  radius_miles?: number | null;
  states?: string[];
  include_shippable?: boolean;
  tiers_only?: SourceTier[];
  min_sleeper_score?: number | null;
  active?: boolean;
  notify_immediately?: boolean;
}

/** 0009: the hunts columns `authenticated` may update. match_count and last_run_at are the runner's. */
export type HuntUpdate = {
  name?: string;
  query_text?: string | null;
  parsed?: Json | null;
  keywords?: string[];
  exclude_keywords?: string[];
  category_ids?: number[];
  brands?: string[];
  required_terms?: string[];
  min_price_cents?: number | null;
  max_price_cents?: number | null;
  conditions?: string[];
  postal_code?: string | null;
  radius_miles?: number | null;
  states?: string[];
  include_shippable?: boolean;
  tiers_only?: SourceTier[];
  min_sleeper_score?: number | null;
  active?: boolean;
  notify_immediately?: boolean;
}

export type HuntMatchRow = {
  id: number;
  hunt_id: string;
  lot_id: string;
  score: number | null;
  reason: Json | null;
  matched_at: string | null;
  notified_at: string | null;
  dismissed: boolean | null;
}

export type WatchOutcome = 'won' | 'lost' | 'passed';

/** 0044: what a user is shopping for, for Finds. */
export type FinderGoalRow = {
  id: string;
  user_id: string;
  name: string;
  mode: 'resale' | 'personal' | 'project';
  focus: string | null;
  budget_cents: number | null;
  min_profit_cents: number | null;
  min_return_pct: number | null;
  postal_code: string | null;
  radius_miles: number | null;
  closing_within_hours: number | null;
  include_shippable: boolean;
  sales_tax_pct: number | null;
  conservative: boolean;
  created_at: string;
  updated_at: string;
};

/** user_id defaults to auth.uid() and RLS pins it there. */
export type FinderGoalInsert = Omit<Partial<FinderGoalRow>, 'id' | 'user_id' | 'created_at' | 'updated_at'> & {
  name: string;
};

export type FinderGoalUpdate = Omit<Partial<FinderGoalRow>, 'id' | 'user_id' | 'created_at' | 'updated_at'>;

/**
 * 0044: one appraisal per lot, written by the appraise-lots function. Users
 * may read these columns only: who asked for it (requested_by) and the batch
 * are not granted.
 */
export type LotAppraisalRow = {
  lot_id: string;
  model: string;
  item: string;
  resale_low_cents: number | null;
  resale_likely_cents: number | null;
  resale_high_cents: number | null;
  new_price_cents: number | null;
  confidence: 'low' | 'medium' | 'high';
  channel: string | null;
  days_to_sell: number | null;
  project_tags: string[];
  flags: string[];
  comps_query: string | null;
  rationale: string | null;
  lot_title: string;
  bid_cents_at: number | null;
  created_at: string;
};

export type WatchlistRow = {
  id: number;
  user_id: string;
  lot_id: string;
  max_bid_cents: number | null;
  notes: string | null;
  remind_seconds_before: number | null;
  reminded_at: string | null;
  placed_bid: boolean | null;
  placed_bid_cents: number | null;
  outcome: string | null;
  created_at: string | null;
}

export type WatchlistInsert = {
  user_id: string;
  lot_id: string;
  max_bid_cents?: number | null;
  notes?: string | null;
  remind_seconds_before?: number | null;
  placed_bid?: boolean;
  placed_bid_cents?: number | null;
  outcome?: WatchOutcome | null;
}

/** watchlist keeps its table grants; RLS (0003) scopes every write to the owner. */
export type WatchlistUpdate = {
  max_bid_cents?: number | null;
  notes?: string | null;
  remind_seconds_before?: number | null;
  placed_bid?: boolean;
  placed_bid_cents?: number | null;
  outcome?: WatchOutcome | null;
}

export type AlertRow = {
  id: number;
  user_id: string;
  kind: AlertKind;
  lot_id: string | null;
  hunt_id: string | null;
  channel: string | null;
  title: string | null;
  body: string | null;
  payload: Json | null;
  created_at: string;
  sent_at: string | null;
  read_at: string | null;
}

// ------------------------------------------------------------------- views

export type SourceStatusRow = {
  slug: string | null;
  name: string | null;
  url: string | null;
  tier: SourceTier | null;
  platform: string | null;
  ingest: IngestMethod | null;
  access_status: AccessStatus | null;
  access_checked_at: string | null;
  last_ok_at: string | null;
  crawl_cadence_min: number | null;
  open_lots: number | null;
}

export type EntitlementsRow = {
  user_id: string | null;
  tier: UserTier | null;
  label: string | null;
  blurb: string | null;
  price_cents_month: number | null;
  max_active_hunts: number | null;
  max_image_hunts: number | null;
  max_watchlist: number | null;
  alert_latency_seconds: number | null;
  image_hunts_allowed: boolean | null;
  rival_intel_allowed: boolean | null;
  csv_export_allowed: boolean | null;
  api_access_allowed: boolean | null;
  hunts_active: number | null;
  image_hunts_active: number | null;
  watchlist_count: number | null;
  hunts_remaining: number | null;
}

// --------------------------------------------------------------- functions

/** search_lots() arguments (0006). Every one has a SQL default. */
export type SearchLotsArgs = {
  p_query?: string | null;
  p_postal_code?: string | null;
  p_radius_miles?: number;
  p_include_shippable?: boolean;
  p_states?: string[] | null;
  p_min_cents?: number | null;
  p_max_cents?: number | null;
  p_category_ids?: number[] | null;
  p_tiers?: SourceTier[] | null;
  p_closing_within_hours?: number | null;
  p_min_sleeper?: number | null;
  p_sort?: SearchSort;
  p_limit?: number;
  p_offset?: number;
  /**
   * 0018: the parser's grouped to_tsquery string (synonyms, model variants).
   * Preferred over p_query when it parses; the server falls back to p_query
   * when it does not, so sending both is always safe.
   */
  p_tsquery?: string | null;
}

/** One search_lots() row. */
export type SearchLotRow = {
  lot_id: string;
  title: string;
  lot_number: string | null;
  url: string | null;
  primary_image_url: string | null;
  image_count: number | null;
  current_bid_cents: number | null;
  next_bid_cents: number | null;
  estimate_low_cents: number | null;
  bid_count: number | null;
  closes_at: string | null;
  auction_title: string | null;
  auctioneer: string | null;
  source_name: string;
  source_tier: SourceTier | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  ships: boolean | null;
  distance_miles: number | null;
  sleeper_score: number | null;
  sleeper_reasons: Json | null;
  relevance: number | null;
  match_basis: MatchBasis;
  /** 0018. Optional only so rows shaped before 0018 (and fixtures) still type-check. */
  pickup_geo_source?: PickupGeoSource | null;
  /**
   * 0023: true for a row that stands for a whole sale. Its price, next bid,
   * bid count and sleeper score are null, and `url` is the sale's page.
   */
  sale_level: boolean;
  /** 0023: the lot count of the row's auction (auctions.lot_count); for a sale-level row, the sale's. May be null. */
  sale_lot_count: number | null;
}

type Rel<Name extends string, Cols extends string, To extends string> = {
  foreignKeyName: Name;
  columns: [Cols];
  isOneToOne: false;
  referencedRelation: To;
  referencedColumns: ['id'];
};

export type Database = {
  __InternalSupabase: { PostgrestVersion: '12' };
  public: {
    Tables: {
      sources: { Row: SourceRow; Insert: never; Update: never; Relationships: [] };
      auctions: {
        Row: AuctionRow;
        Insert: never;
        Update: never;
        Relationships: [Rel<'auctions_source_id_fkey', 'source_id', 'sources'>];
      };
      lots: {
        Row: LotRow;
        /** The catalogue is service-role only (0003), sale_level (0023) included: the browser writes no lots column. */
        Insert: never;
        Update: never;
        Relationships: [
          Rel<'lots_auction_id_fkey', 'auction_id', 'auctions'>,
          Rel<'lots_source_id_fkey', 'source_id', 'sources'>,
          Rel<'lots_category_id_fkey', 'category_id', 'categories'>,
        ];
      };
      lot_images: {
        Row: LotImageRow;
        Insert: never;
        Update: never;
        Relationships: [Rel<'lot_images_lot_id_fkey', 'lot_id', 'lots'>];
      };
      categories: { Row: CategoryRow; Insert: never; Update: never; Relationships: [] };
      postal_codes: { Row: PostalCodeRow; Insert: never; Update: never; Relationships: [] };
      tier_limits: { Row: TierLimitsRow; Insert: never; Update: never; Relationships: [] };
      profiles: { Row: ProfileRow; Insert: never; Update: ProfileUpdate; Relationships: [] };
      hunts: { Row: HuntRow; Insert: HuntInsert; Update: HuntUpdate; Relationships: [] };
      finder_goals: { Row: FinderGoalRow; Insert: FinderGoalInsert; Update: FinderGoalUpdate; Relationships: [] };
      lot_appraisals: {
        Row: LotAppraisalRow;
        /** Written by the appraise-lots function only (0044). */
        Insert: never;
        Update: never;
        Relationships: [Rel<'lot_appraisals_lot_id_fkey', 'lot_id', 'lots'>];
      };
      hunt_matches: {
        Row: HuntMatchRow;
        Insert: never;
        /** 0009: `grant update (dismissed)`. */
        Update: { dismissed?: boolean };
        Relationships: [
          Rel<'hunt_matches_hunt_id_fkey', 'hunt_id', 'hunts'>,
          Rel<'hunt_matches_lot_id_fkey', 'lot_id', 'lots'>,
        ];
      };
      watchlist: {
        Row: WatchlistRow;
        Insert: WatchlistInsert;
        Update: WatchlistUpdate;
        Relationships: [Rel<'watchlist_lot_id_fkey', 'lot_id', 'lots'>];
      };
      alerts: {
        Row: AlertRow;
        Insert: never;
        /** 0009: `grant update (read_at)`. */
        Update: { read_at?: string | null };
        Relationships: [
          Rel<'alerts_lot_id_fkey', 'lot_id', 'lots'>,
          Rel<'alerts_hunt_id_fkey', 'hunt_id', 'hunts'>,
        ];
      };
    };
    Views: {
      v_source_status: { Row: SourceStatusRow; Relationships: [] };
      v_my_entitlements: { Row: EntitlementsRow; Relationships: [] };
    };
    Functions: {
      search_lots: { Args: SearchLotsArgs; Returns: SearchLotRow[] };
      run_my_hunt: { Args: { p_hunt_id: string }; Returns: Json };
    };
    Enums: {
      source_tier: SourceTier;
      ingest_method: IngestMethod;
      auction_format: AuctionFormat;
      user_tier: UserTier;
      alert_kind: AlertKind;
    };
    CompositeTypes: Record<string, never>;
  };
}
