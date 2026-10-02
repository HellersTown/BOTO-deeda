/**
 * In-app alerts. 0013 writes one 'in_app' row per alert (plus an 'email' row
 * for users who opted in); the app shows only the in_app channel.
 *
 * 0009 grants `update (read_at)` to authenticated, so marking read works and
 * nothing else about an alert is writable. alerts is in the supabase_realtime
 * publication (0013) and realtime applies RLS, so a subscription only ever
 * receives the user's own rows.
 */
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import type { AlertRow } from './database.types';
import { toDataError } from './errors';
import { db } from './supabase';

export const IN_APP_CHANNEL = 'in_app';

const ALERT_COLUMNS = 'id, user_id, kind, lot_id, hunt_id, channel, title, body, payload, created_at, sent_at, read_at' as const;

export async function listMyAlerts(userId: string, limit = 100): Promise<AlertRow[]> {
  const { data, error } = await db()
    .from('alerts')
    .select(ALERT_COLUMNS)
    .eq('user_id', userId)
    .eq('channel', IN_APP_CHANNEL)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw toDataError(error, 'alerts');
  return data ?? [];
}

export async function countMyUnreadAlerts(userId: string): Promise<number> {
  const { count, error } = await db()
    .from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('channel', IN_APP_CHANNEL)
    .is('read_at', null);
  if (error) throw toDataError(error, 'unread alerts');
  return count ?? 0;
}

export async function markAlertRead(alertId: number, at: Date = new Date()): Promise<void> {
  const { error } = await db().from('alerts').update({ read_at: at.toISOString() }).eq('id', alertId).is('read_at', null);
  if (error) throw toDataError(error, 'mark alert read');
}

export async function markAllAlertsRead(userId: string, at: Date = new Date()): Promise<void> {
  const { error } = await db()
    .from('alerts')
    .update({ read_at: at.toISOString() })
    .eq('user_id', userId)
    .eq('channel', IN_APP_CHANNEL)
    .is('read_at', null);
  if (error) throw toDataError(error, 'mark all read');
}

export type AlertChange = RealtimePostgresChangesPayload<AlertRow>;

/** Live inserts and updates of the user's alerts. Returns the unsubscribe function. */
export function subscribeToMyAlerts(userId: string, onChange: (change: AlertChange) => void): () => void {
  const client = db();
  const channel = client
    .channel(`alerts:${userId}`)
    .on<AlertRow>(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'alerts', filter: `user_id=eq.${userId}` },
      (change) => onChange(change),
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}
