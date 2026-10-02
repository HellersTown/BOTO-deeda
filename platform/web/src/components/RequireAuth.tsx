import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';
import { ConfigMissing } from './ConfigMissing';
import { LoadingState } from './States';

/** Hunts, bids, alerts and the profile need an account; everything else is public. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, configured } = useAuth();
  const location = useLocation();
  if (!configured) return <ConfigMissing />;
  if (loading) return <LoadingState label="Checking your sign-in" />;
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
