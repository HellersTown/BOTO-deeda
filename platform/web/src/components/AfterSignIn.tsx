import { Navigate } from 'react-router-dom';
import { needsOnboarding } from '../lib/onboarding';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';
import { LoadingState } from './States';

/**
 * Where a fresh sign-in goes: "Before you set out" once, when the profile has
 * no home ZIP and has not been through it; otherwise straight on to `next`.
 * It waits for the user's profile to load first (a ZIP set on this device
 * before signing in is carried into it, and then no questions are needed).
 */
export function AfterSignIn({ next }: { next: string }) {
  const { user } = useAuth();
  const home = useHome();
  if (!user) return null;
  if (home.profileFor !== user.id) return <LoadingState label="Signing you in" />;
  if (needsOnboarding(home.profile)) return <Navigate to={`/welcome?next=${encodeURIComponent(next)}`} replace />;
  return <Navigate to={next} replace />;
}
