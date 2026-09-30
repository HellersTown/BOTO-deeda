/**
 * The unread badge on the Alerts tab, kept live with Supabase Realtime (the
 * alerts table is in the supabase_realtime publication, 0013, and RLS applies,
 * so only the user's own rows arrive).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { countMyUnreadAlerts, subscribeToMyAlerts } from '../data/alerts';
import { useAuth } from './AuthProvider';

export interface AlertsState {
  readonly unread: number;
  /** Increments on every realtime change, so the Alerts page can reload. */
  readonly version: number;
  readonly refresh: () => void;
}

const AlertsContext = createContext<AlertsState>({ unread: 0, version: 0, refresh: () => undefined });

export function AlertsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);

  const recount = useCallback(() => {
    if (!userId) return;
    countMyUnreadAlerts(userId)
      .then(setUnread)
      .catch((err: unknown) => console.warn(err));
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setUnread(0);
      return;
    }
    recount();
    return subscribeToMyAlerts(userId, () => {
      setVersion((v) => v + 1);
      recount();
    });
  }, [userId, recount]);

  const refresh = useCallback(() => {
    recount();
    setVersion((v) => v + 1);
  }, [recount]);

  const value = useMemo(() => ({ unread, version, refresh }), [unread, version, refresh]);
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export function useAlerts(): AlertsState {
  return useContext(AlertsContext);
}
