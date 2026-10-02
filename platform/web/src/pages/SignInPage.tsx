import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AfterSignIn } from '../components/AfterSignIn';
import { ConfigMissing } from '../components/ConfigMissing';
import { Wordmark } from '../components/Logo';
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

/** The road from home to the horizon (SignIn.dc.html): decorative. */
function RoadAhead() {
  return (
    <svg className="signin__road" viewBox="0 0 342 168" aria-hidden="true" focusable="false">
      <circle cx="266" cy="58" r="26" fill="var(--brass)" />
      <rect x="0" y="58" width="342" height="110" fill="var(--ground)" />
      <path d="M0 58L46 40L82 54L128 30L172 58" fill="none" stroke="var(--pine)" strokeWidth="2" strokeLinejoin="round" />
      <line x1="0" y1="58" x2="342" y2="58" stroke="var(--line-field)" strokeWidth="1.5" />
      <path
        d="M34 162C132 150 36 116 152 104S262 86 266 62"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="2.2"
        strokeDasharray="3 7"
        strokeLinecap="round"
      />
      <circle cx="152" cy="104" r="4.5" fill="var(--pine)" />
      <circle cx="34" cy="162" r="6" fill="var(--ember)" />
    </svg>
  );
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
  if (!loading && user) return <AfterSignIn next={next} />;

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
        <Wordmark size={28} markSize={34} />
        <RoadAhead />
        <h1 className="signin__title">Equip for the road ahead.</h1>
        <p className="signin__lead">
          Tools, provisions and gear from government, school, private and estate auctions near you, checked every hour and
          watched until you have what you need.
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
          Skeuos never bids for you. When it’s time, it opens the lot on the auction’s own site and you bid there.
        </p>
        <p className="signin__note">
          <Link to="/">Search without an account</Link>
        </p>
      </form>
    </div>
  );
}
