import { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { RADIUS_OPTIONS } from '../components/LocationDialog';
import { ErrorState, LoadingState } from '../components/States';
import { signOut } from '../data/auth';
import type { ProfileUpdate, TierLimitsRow } from '../data/database.types';
import { describeError } from '../data/errors';
import { lookupPostalCode, normalizeZip } from '../data/postal';
import { getSourceCoverage, listTierLimits } from '../data/profile';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { latencyWords } from '../lib/dates';
import { formatCentsShort } from '../lib/money';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';

const US_ZONES: readonly string[] = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

function hourLabel(h: number): string {
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour} ${suffix}`;
}

/** "3 hunts · alerts within the hour · 25 watched lots": a plan's limits, from tier_limits. */
function planLine(t: TierLimitsRow): string {
  const parts: string[] = [];
  if (t.max_active_hunts !== null) parts.push(`${t.max_active_hunts} hunts`);
  parts.push(`alerts ${latencyWords(t.alert_latency_seconds)}`);
  if (t.max_watchlist !== null) parts.push(`${t.max_watchlist} watched lots`);
  if (t.image_hunts_allowed) parts.push(t.max_image_hunts ? `${t.max_image_hunts} photo hunts` : 'photo hunts');
  if (t.rival_intel_allowed) parts.push('who’s bidding');
  if (t.csv_export_allowed) parts.push('CSV export');
  if (t.api_access_allowed) parts.push('API');
  return parts.join(' · ');
}

function priceLabel(t: TierLimitsRow): string {
  if (t.price_cents_month === null) return '';
  return t.price_cents_month === 0 ? '$0' : `${formatCentsShort(t.price_cents_month)}/mo`;
}

export function ProfilePage() {
  useDocumentTitle('Profile');
  const { user } = useAuth();
  const home = useHome();
  const navigate = useNavigate();
  const location = useLocation();
  const profile = home.profile;
  const zipId = useId();
  const radiusId = useId();
  const tzId = useId();
  const startId = useId();
  const endId = useId();

  const plans = useAsync(() => listTierLimits(), []);
  const coverage = useAsync(() => getSourceCoverage(), []);

  const [zip, setZip] = useState(profile?.home_postal_code ?? '');
  useEffect(() => setZip(profile?.home_postal_code ?? ''), [profile?.home_postal_code]);
  const [zipError, setZipError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [quietOpen, setQuietOpen] = useState(false);

  useEffect(() => {
    if (location.hash === '#plan') document.getElementById('plan')?.scrollIntoView();
  }, [location.hash, plans.data]);

  async function save(patch: ProfileUpdate, what: string) {
    setStatus('Saving…');
    try {
      await home.updateProfile(patch);
      setStatus(`${what} saved.`);
    } catch (err) {
      setStatus(null);
      setZipError(what === 'Home ZIP' ? describeError(err) : null);
      if (what !== 'Home ZIP') setStatus(describeError(err));
    }
  }

  async function saveZip() {
    setZipError(null);
    if (zip.trim() === '' || zip.trim() === profile?.home_postal_code) return;
    const normalized = normalizeZip(zip);
    if (!normalized) {
      setZipError('Enter a 5-digit ZIP code.');
      return;
    }
    try {
      const place = await lookupPostalCode(normalized);
      if (!place) {
        setZipError(`ZIP ${normalized} is not in our ZIP list. Check it, or try a nearby ZIP.`);
        return;
      }
      setZip(normalized);
      await save({ home_postal_code: normalized }, 'Home ZIP');
    } catch (err) {
      setZipError(describeError(err));
    }
  }

  if (home.profileLoading && !profile) return <LoadingState label="Loading your profile" />;
  if (home.profileError && !profile) {
    return (
      <div className="page">
        <ErrorState error={home.profileError} onRetry={home.reloadProfile} title="Your profile did not load" />
      </div>
    );
  }

  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = profile?.timezone ?? 'America/Chicago';
  const zones = [...new Set([...US_ZONES, zone, deviceZone])];
  const radius = profile?.radius_miles ?? home.radiusMiles;
  const radii = RADIUS_OPTIONS.includes(radius) ? RADIUS_OPTIONS : [...RADIUS_OPTIONS, radius].sort((a, b) => a - b);
  const qStart = profile?.quiet_hours_start ?? null;
  const qEnd = profile?.quiet_hours_end ?? null;
  const quietText = qStart !== null && qEnd !== null ? `${hourLabel(qStart)} – ${hourLabel(qEnd)}` : 'Off';
  const currentTier = profile?.tier ?? 'free';
  const c = coverage.data;

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Profile</h1>
      </header>
      <p className="visually-hidden" aria-live="polite">
        {status ?? ''}
      </p>

      <div className="stack">
        <section aria-labelledby="home" className="card profile-card">
          <h2 id="home" className="card__title">
            Where you bid from
          </h2>
          <div className="field-grid">
            <div className="field">
              <label htmlFor={zipId}>Home ZIP</label>
              <input
                id={zipId}
                className="input"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={10}
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                onBlur={() => void saveZip()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveZip();
                  }
                }}
                aria-invalid={zipError ? true : undefined}
                aria-describedby={`${zipId}-note`}
              />
              <span id={`${zipId}-note`} className={zipError ? 'field-error' : 'field__hint'}>
                {zipError ?? (home.place ? `${home.place.city ?? ''}${home.place.city ? ', ' : ''}${home.place.state}` : 'Ranks lots by distance')}
              </span>
            </div>
            <div className="field">
              <label htmlFor={radiusId}>Drive up to</label>
              <select id={radiusId} className="input" value={radius} onChange={(e) => void save({ radius_miles: Number(e.target.value) }, 'Distance')}>
                {radii.map((r) => (
                  <option key={r} value={r}>
                    {r} mi
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section aria-labelledby="notify" className="card profile-card">
          <h2 id="notify" className="card__title">
            Notifications
          </h2>
          <label className="switch-row">
            <span>In the app</span>
            <input type="checkbox" className="checkbox" checked disabled aria-describedby="inapp-note" />
          </label>
          <span id="inapp-note" className="visually-hidden">
            Always on
          </span>
          <label className="switch-row">
            <span>Email</span>
            <input
              type="checkbox"
              className="checkbox"
              checked={profile?.notify_email ?? true}
              onChange={(e) => void save({ notify_email: e.target.checked }, 'Email alerts')}
            />
          </label>
          <label className="switch-row">
            <span>
              Push notifications
              <span className="block small muted">Saved for when push delivery launches; today alerts arrive here and by email.</span>
            </span>
            <input
              type="checkbox"
              className="checkbox"
              checked={profile?.notify_push ?? true}
              onChange={(e) => void save({ notify_push: e.target.checked }, 'Push preference')}
            />
          </label>
          <div className="switch-row">
            <span>Quiet hours</span>
            <button type="button" className="btn btn--chip" aria-expanded={quietOpen} onClick={() => setQuietOpen((o) => !o)}>
              {quietText}
            </button>
          </div>
          {quietOpen ? (
            <div className="quiet">
              <p className="small muted">Email alerts wait until quiet hours end. In-app alerts still arrive.</p>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor={startId}>From</label>
                  <select
                    id={startId}
                    className="input"
                    value={qStart ?? ''}
                    onChange={(e) => {
                      const v = e.target.value === '' ? null : Number(e.target.value);
                      void save(v === null ? { quiet_hours_start: null, quiet_hours_end: null } : { quiet_hours_start: v, quiet_hours_end: qEnd ?? 7 }, 'Quiet hours');
                    }}
                  >
                    <option value="">Off</option>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={endId}>Until</label>
                  <select
                    id={endId}
                    className="input"
                    value={qEnd ?? ''}
                    disabled={qStart === null}
                    onChange={(e) => void save({ quiet_hours_end: Number(e.target.value) }, 'Quiet hours')}
                  >
                    {qStart === null ? <option value="">Off</option> : null}
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={tzId}>Your time zone</label>
            <select id={tzId} className="input" value={zone} onChange={(e) => void save({ timezone: e.target.value }, 'Time zone')}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                  {z === deviceZone ? ' (this device)' : ''}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section aria-labelledby="plan" id="plan" className="plans">
          <h2 className="card__title" id="plan-title">
            Plan
          </h2>
          {plans.loading && !plans.data ? (
            <LoadingState label="Loading plans" />
          ) : plans.error ? (
            <ErrorState error={plans.error} onRetry={plans.reload} title="Plans did not load" />
          ) : (
            (plans.data ?? []).map((t) => {
              const current = t.tier === currentTier;
              return (
                <div key={t.tier} className={`plan-card${current ? ' plan-card--current' : ''}`}>
                  <div className="plan-card__text">
                    <span className="plan-card__name">
                      {t.label ?? t.tier}
                      {current ? <span className="plan-card__current"> · current</span> : null}
                    </span>
                    <span className="plan-card__line">{planLine(t)}</span>
                  </div>
                  <div className="plan-card__side">
                    <span className="plan-card__price">{priceLabel(t)}</span>
                    {!current ? (
                      <button type="button" className="btn btn--chip" disabled>
                        Coming soon
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </section>

        {c ? (
          <p className="coverage">
            {c.total} auction {c.total === 1 ? 'site is' : 'sites are'} checked every hour. {c.open} can be searched here
            {c.blocked > 0
              ? `; ${c.blocked} turn away automated visitors, so for those we open the site for you instead (deep link only)`
              : ''}
            .{c.other > 0 ? ` ${c.other} more are still being checked.` : ''}
          </p>
        ) : coverage.error ? null : null}

        <section className="card profile-card" aria-labelledby="account">
          <h2 id="account" className="card__title">
            Account
          </h2>
          <p className="small">Signed in as {user?.email ?? 'you'}.</p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => {
                void signOut()
                  .catch((err: unknown) => console.warn(err))
                  .finally(() => navigate('/', { replace: true }));
              }}
            >
              Sign out
            </button>
            <Link to="/about" className="btn btn--ghost btn--small">
              About the name Skeuos
            </Link>
          </div>
        </section>

        <p className="small muted attribution">
          ZIP code locations: U.S. Census Bureau ZCTA gazetteer (public domain) and{' '}
          <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">
            GeoNames
          </a>{' '}
          (CC BY 4.0).
        </p>
      </div>
    </div>
  );
}
