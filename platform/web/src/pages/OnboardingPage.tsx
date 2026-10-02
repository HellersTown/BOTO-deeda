import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LoadingState } from '../components/States';
import { DataError, describeError } from '../data/errors';
import { createHunt, runMyHunt } from '../data/hunts';
import { lookupPostalCode, normalizeZip } from '../data/postal';
import { getMyEntitlements, listTierLimits } from '../data/profile';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  capMessage,
  GATHER_CHOICES,
  huntAllowance,
  initialRadius,
  ONBOARDING_RADII,
  onboardingHunts,
  toggleChoice,
} from '../lib/onboarding';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';
import { safeNext } from './SignInPage';

/** Where to go afterwards: the page the sign-in was for, else search. Never back here. */
function destination(value: string | null): string {
  const next = safeNext(value);
  return next.startsWith('/welcome') ? '/' : next;
}

/**
 * "Before you set out" (Onboard.dc.html), shown once after sign-in to a profile
 * with no home ZIP. The ZIP is checked against postal_codes as on the Profile
 * page; each picked choice becomes a hunt, up to the plan's limit.
 */
export function OnboardingPage() {
  useDocumentTitle('Before you set out');
  const { user } = useAuth();
  const home = useHome();
  // The fields start from the profile, so wait for it (the page can be opened directly).
  if (user && home.profileFor !== user.id) {
    return (
      <div className="setout">
        <LoadingState label="Getting ready" />
      </div>
    );
  }
  return <OnboardingForm />;
}

function OnboardingForm() {
  const { user } = useAuth();
  const home = useHome();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = destination(params.get('next'));
  const zipId = useId();
  const zipHintId = useId();
  const radiusName = useId();

  const [zip, setZip] = useState(home.profile?.home_postal_code ?? home.zip ?? '');
  const [radius, setRadius] = useState(() => initialRadius(home.profile?.radius_miles ?? home.radiusMiles));
  const [picked, setPicked] = useState<string[]>([]);
  const [started, setStarted] = useState<string[]>([]);
  const [zipError, setZipError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ent = useAsync(() => getMyEntitlements(), [user?.id], Boolean(user));
  const needLimits = Boolean(user) && !ent.loading && (ent.error !== null || ent.data === null);
  const limits = useAsync(() => listTierLimits(), [needLimits], needLimits);
  const allowance = useMemo(
    () => huntAllowance(ent.data ?? null, limits.data ?? null, home.profile?.tier ?? null),
    [ent.data, limits.data, home.profile?.tier],
  );
  // Hunts started on an earlier try of this page already use their slots.
  const slots = allowance.slots === null ? null : Math.max(0, allowance.slots - started.length);
  const pending = picked.filter((k) => !started.includes(k));
  const cap = capMessage({ ...allowance, slots, active: allowance.active + started.length }, pending.length);
  const atCap = slots !== null && pending.length >= slots;

  function toggle(key: string) {
    setPicked((current) => {
      const done = current.filter((k) => started.includes(k));
      const result = toggleChoice(
        current.filter((k) => !started.includes(k)),
        key,
        slots,
      );
      return [...done, ...result.picked];
    });
  }

  async function markSeen(): Promise<void> {
    try {
      await home.updateProfile({ onboarded_at: new Date().toISOString() });
    } catch (err) {
      console.warn(err); // Not fatal: the page simply may be offered again at the next sign-in.
    }
  }

  async function skip() {
    setBusy(true);
    await markSeen();
    navigate(next, { replace: true });
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    setZipError(null);
    setError(null);
    const normalized = normalizeZip(zip);
    if (!normalized) {
      setZipError('Enter a 5-digit ZIP code.');
      return;
    }
    setBusy(true);
    try {
      const place = await lookupPostalCode(normalized);
      if (!place) {
        setZipError(`ZIP ${normalized} is not in our ZIP list. Check it, or try a nearby ZIP.`);
        return;
      }
      setZip(normalized);
      await home.updateProfile({ home_postal_code: normalized, radius_miles: radius, onboarded_at: new Date().toISOString() });

      const hunts = onboardingHunts(pending, { userId: user.id, homePostalCode: normalized, radiusMiles: radius, slots });
      const created: string[] = [];
      const failed: string[] = [];
      let limitHit = false;
      for (const { choice, insert } of hunts) {
        try {
          const hunt = await createHunt(insert);
          created.push(choice.key);
          // The first check fills the hunt's matches now; the scheduled run does it anyway.
          void runMyHunt(hunt.id).catch((err: unknown) => console.warn(err));
        } catch (err) {
          if (err instanceof DataError && err.kind === 'hunt_limit') {
            limitHit = true;
            break;
          }
          console.warn(err);
          failed.push(choice.label);
        }
      }
      setStarted((s) => [...s, ...created]);
      const total = started.length + created.length;
      if (limitHit || failed.length > 0) {
        const missed = hunts.filter((h) => !created.includes(h.choice.key)).map((h) => h.choice.label);
        setError(
          limitHit
            ? `${total > 0 ? `${total} ${total === 1 ? 'hunt is' : 'hunts are'} keeping watch. ` : ''}Your plan has no room for ${missed.join(', ')}. Pause a hunt in Hunts to make room.`
            : `${total > 0 ? `${total} ${total === 1 ? 'hunt is' : 'hunts are'} keeping watch. ` : ''}${failed.join(', ')} did not start. Try again, or go on without ${failed.length === 1 ? 'it' : 'them'}.`,
        );
        return;
      }
      navigate(next, { replace: true, state: { setOut: { hunts: total } } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setout">
      <header className="setout__head">
        <h1 className="eyebrow">Before you set out</h1>
        <button type="button" className="setout__skip" onClick={() => void skip()} disabled={busy}>
          Skip
        </button>
      </header>

      <form className="setout__form" onSubmit={start} noValidate>
        <div className="setout__field">
          <label htmlFor={zipId} className="setout__question">
            Where do you set out from?
          </label>
          <input
            id={zipId}
            className="input input--strong input--tall input--mono setout__zip"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={10}
            value={zip}
            onChange={(e) => {
              setZip(e.target.value);
              setZipError(null);
            }}
            aria-invalid={zipError ? true : undefined}
            aria-describedby={zipHintId}
          />
          <span id={zipHintId} className={zipError ? 'field-error' : 'setout__hint'} role={zipError ? 'alert' : undefined}>
            {zipError ?? 'Your ZIP code. Every distance and pickup trip starts here.'}
          </span>
        </div>

        <fieldset className="setout__group">
          <legend className="setout__legend">How far will you travel for the right thing?</legend>
          <div className="radius-tiles">
            {ONBOARDING_RADII.map((r) => (
              <label key={r} className={`radius-tile${radius === r ? ' radius-tile--on' : ''}`}>
                <input type="radio" name={radiusName} value={r} checked={radius === r} onChange={() => setRadius(r)} />
                {r} mi
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="setout__group">
          <legend className="setout__legend">What are you gathering?</legend>
          <div className="gather">
            {GATHER_CHOICES.map((c) => {
              const on = picked.includes(c.key);
              const done = started.includes(c.key);
              const blocked = !on && atCap;
              return (
                <label key={c.key} className={`gather__chip${on ? ' gather__chip--on' : ''}${blocked ? ' gather__chip--blocked' : ''}`}>
                  <input type="checkbox" checked={on} disabled={done || blocked || busy} onChange={() => toggle(c.key)} />
                  {c.label}
                  {done ? <span className="visually-hidden"> (keeping watch)</span> : null}
                </label>
              );
            })}
          </div>
          <p className="setout__hint">Each one you pick becomes a hunt. Change them any time.</p>
          {cap ? (
            <p className="setout__cap" role="status">
              {cap}
            </p>
          ) : null}
        </fieldset>

        {error ? (
          <div className="setout__error" role="alert">
            <p>{error}</p>
            <Link to={next} replace>
              Go on without {started.length > 0 ? 'the rest' : 'them'}
            </Link>
          </div>
        ) : null}

        <div className="setout__foot">
          <button type="submit" className="btn btn--primary btn--large btn--block" disabled={busy}>
            {busy ? 'Getting ready…' : 'Start watching'}
          </button>
        </div>
      </form>
    </div>
  );
}
