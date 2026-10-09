import type { Session, User } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getSession, onAuthStateChange } from '../data/auth';
import { isConfigured } from '../data/supabase';

export interface AuthState {
  readonly session: Session | null;
  readonly user: User | null;
  /** True until the stored session (or a sign-in link in the URL) has been read. */
  readonly loading: boolean;
  /** False when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing. */
  readonly configured: boolean;
}

const AuthContext = createContext<AuthState>({ session: null, user: null, loading: true, configured: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isConfigured();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(configured);

  useEffect(() => {
    if (!configured) return;
    let active = true;
    getSession()
      .then((s) => {
        if (active) setSession(s);
      })
      .catch((err: unknown) => console.warn(err))
      .finally(() => {
        if (active) setLoading(false);
      });
    const off = onAuthStateChange((_event, s) => {
      setSession(s);
      setLoading(false);
    });
    return () => {
      active = false;
      off();
    };
  }, [configured]);

  const value = useMemo<AuthState>(
    () => ({ session, user: session?.user ?? null, loading, configured }),
    [session, loading, configured],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
