import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ConfigMissing } from '../components/ConfigMissing';
import { JarMark } from '../components/Logo';
import { sendMagicLink, signInWithPassword, signUpWithPassword } from '../data/auth';
import { DataError, describeError } from '../data/errors';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { readStored, writeStored } from '../lib/storage';
import { useAuth } from '../providers/AuthProvider';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only same-app paths, so a crafted ?next= cannot send people elsewhere. */
export function safeNext(value: string | null | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function rememberNext(next: string): void {
  writeStored('next', safeNext(next));
}

export function recallNext(): string {
  return safeNext(readStored('next', (v): v is string => typeof v === 'string'));
}

function authMessage(err: unknown): string {
  if (err instanceof DataError && err.kind !== 'network') {
    const raw = err.message.replace(/^[^:]+:\s*/, '');
    if (/invalid login credentials/i.test(raw)) return 'That email and password do not match an account.';
    if (/already registered|already exists/i.test(raw)) return 'There is already an account for that email. Sign in instead.';
    if (/password/i.test(raw)) return raw;
    if (/rate limit|too many/i.test(raw)) return 'Too many attempts. Wait a minute and try again.';
    if (/email not confirmed/i.test(raw)) return 'Confirm your email first: open the link we sent you.';
  }
  return describeError(err);
}

export function SignInPage() {
  useDocumentTitle('Sign in');
  const { user, loading, configured } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'link' | 'password'>('link');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => rememberNext(next), [next]);

  if (!configured) return <ConfigMissing />;
  if (!loading && user) return <Navigate to={next} replace />;

  async function run(fn: () => Promise<void>) {
    setError(null);
    setSent(null);
    if (!EMAIL.test(email.trim())) {
      setError('Enter your email address.');
      return;
    }
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'link') {
      void run(async () => {
        await sendMagicLink(email.trim());
        setSent(`Check your email. We sent a sign-in link to ${email.trim()}. Open it on this device.`);
      });
    } else {
      void run(async () => {
        if (password.length < 6) throw new DataError('sign in: Password should be at least 6 characters.', 'invalid');
        await signInWithPassword(email.trim(), password);
      });
    }
  }

  function createAccount() {
    void run(async () => {
      if (password.length < 6) throw new DataError('sign up: Password should be at least 6 characters.', 'invalid');
      const session = await signUpWithPassword(email.trim(), password);
      if (!session) setSent(`Almost there. We sent a confirmation link to ${email.trim()}; open it to finish.`);
    });
  }

  return (
    <div className="signin">
      <div className="signin__intro">
        <div className="signin__mark">
          <JarMark size={38} />
        </div>
        <h1 className="signin__title">Every useful thing, at every auction near you.</h1>
        <p className="signin__lead">
          Federal, state, county, school, private and estate sales, checked every hour. Describe what you need and Skeuos
          keeps looking.
        </p>
      </div>

      <form className="signin__form" onSubmit={submit} noValidate>
        <label htmlFor={emailId} className="field__label--strong">
          Email
        </label>
        <input
          id={emailId}
          type="email"
          className="input input--strong input--tall"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${emailId}-error` : undefined}
        />
        {mode === 'password' ? (
          <>
            <label htmlFor={passwordId} className="field__label--strong">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              className="input input--strong input--tall"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        ) : null}

        {error ? (
          <p id={`${emailId}-error`} className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {sent ? (
          <p className="form-note form-note--ok" role="status">
            {sent}
          </p>
        ) : null}

        {mode === 'link' ? (
          <>
            <button type="submit" className="btn btn--primary btn--large" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            <button type="button" className="btn btn--secondary btn--tall" onClick={() => setMode('password')}>
              Use a password instead
            </button>
          </>
        ) : (
          <>
            <button type="submit" className="btn btn--primary btn--large" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" className="btn btn--secondary btn--tall" onClick={createAccount} disabled={busy}>
              Create an account
            </button>
            <button type="button" className="link-btn" onClick={() => setMode('link')}>
              Email me a link instead
            </button>
          </>
        )}

        <p className="signin__note">
          Skeuos never bids for you. When it is time, it opens the lot on the auction’s own site so you place the bid there.
        </p>
        <p className="signin__note">
          <Link to="/">Search without an account</Link> · <Link to="/about">What does Skeuos mean?</Link>
        </p>
      </form>
    </div>
  );
}
