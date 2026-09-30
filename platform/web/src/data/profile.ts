/**
 * The signed-in user's profile, plan entitlements, the public plan table and
 * public source coverage.
 *
 *   profiles           own row only (0003); writable columns per 0009
 *   v_my_entitlements  security_invoker view (0004): plan + usage for auth.uid()
 *   tier_limits        public read (0003), values from 0004
 *   v_source_status    readable by anon (0010)
 */
import type {
  EntitlementsRow,
  ProfileRow,
  ProfileUpdate,
  SourceStatusRow,
  TierLimitsRow,
  UserTier,
} from './database.types';
import { toDataError } from './errors';
import { db } from './supabase';

const PROFILE_SELECT =
  'id, display_name, home_postal_code, radius_miles, tier, timezone, notify_email, notify_push, quiet_hours_start, quiet_hours_end, onboarded_at, created_at' as const;

export async function getMyProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await db().from('profiles').select(PROFILE_SELECT).eq('id', userId).maybeSingle();
  if (error) throw toDataError(error, 'profile');
  return data;
}

/** Only the 0009-granted columns can be passed; `tier` is billing's, not the user's. */
export async function updateMyProfile(userId: string, patch: ProfileUpdate): Promise<ProfileRow> {
  const { data, error } = await db().from('profiles').update(patch).eq('id', userId).select(PROFILE_SELECT).single();
  if (error) throw toDataError(error, 'profile update');
  return data;
}

export async function getMyEntitlements(): Promise<EntitlementsRow | null> {
  const { data, error } = await db().from('v_my_entitlements').select('*').maybeSingle();
  if (error) throw toDataError(error, 'entitlements');
  return data;
}

const TIER_ORDER: readonly UserTier[] = ['free', 'pro', 'dealer'];

export async function listTierLimits(): Promise<TierLimitsRow[]> {
  const { data, error } = await db()
    .from('tier_limits')
    .select(
      'tier, label, blurb, price_cents_month, max_active_hunts, max_image_hunts, max_watchlist, alert_latency_seconds, image_hunts_allowed, rival_intel_allowed, csv_export_allowed, api_access_allowed',
    );
  if (error) throw toDataError(error, 'tier_limits');
  return [...(data ?? [])].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}

export interface SourceCoverage {
  /** Active sources (the view lists only active ones). */
  readonly total: number;
  /** access_status = 'open': searchable here. */
  readonly open: number;
  /** access_status = 'blocked': a bot manager turns our crawler away, so these are deep-link only. */
  readonly blocked: number;
  /** Everything else: robots-disallowed, unreachable, deep-link-only by design, or not probed yet. */
  readonly other: number;
}

export function summarizeCoverage(rows: readonly Pick<SourceStatusRow, 'access_status'>[]): SourceCoverage {
  const open = rows.filter((r) => r.access_status === 'open').length;
  const blocked = rows.filter((r) => r.access_status === 'blocked').length;
  return { total: rows.length, open, blocked, other: rows.length - open - blocked };
}

export async function getSourceCoverage(): Promise<SourceCoverage> {
  const { data, error } = await db().from('v_source_status').select('access_status');
  if (error) throw toDataError(error, 'v_source_status');
  return summarizeCoverage(data ?? []);
}
