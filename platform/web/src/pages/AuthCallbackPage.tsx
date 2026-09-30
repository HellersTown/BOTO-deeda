import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { JarMark } from '../components/Logo';
import { exchangeCode } from '../data/auth';
import { describeError } from '../data/errors';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../providers/AuthProvider';
import { recallNext } from './SignInPage';

/** Reads error details from both the query string and the hash (implicit-flow errors arrive in the hash). */
function urlError(): string | null {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const description = query.get('error_description') ?? hash.get('error_description');
  const code = query.get('error_code') ?? hash.get('error_code');
  if (!description && !code) return null;
  if (code === 'otp_expired' || /expired|invalid/i.test(description ?? '')) {
    return 'This sign-in link has expired or was already used. Request a new one.';
  }
  return description ?? 'Sign-in did not complete.';
}

export function AuthCallbackPage() {
  useDocumentTitle('Signing in');
  const { user, loading } = useAuth();
  const [error, setError] = useState<string | null>(() => urlError());
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (error) return;
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
      exchangeCode(code).catch((err: unknown) => {
        setError(
          /verifier|flow/i.test(String((err as Error).message))
            ? 'Open the sign-in link in the same browser you requested it from, or request a new one here.'
            : describeError(err),
        );
      });
    }
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  if (user && !error) return <Navigate to={recallNext()} replace />;

  return (
    <div className="signin signin--center">
      <div className="signin__mark">
        <JarMark size={38} />
      </div>
      {error || (slow && !loading) ? (
        <div className="state state--error" role="alert">
          <p className="state__title">We could not sign you in</p>
          <p>{error ?? 'This sign-in link did not work. It may have expired or been used already.'}</p>
          <Link to="/signin" className="btn btn--primary">
            Request a new link
          </Link>
        </div>
      ) : (
        <div className="state" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Signing you in…</span>
        </div>
      )}
    </div>
  );
}
