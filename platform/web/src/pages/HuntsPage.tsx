import { Link } from 'react-router-dom';
import { PlusIcon } from '../components/Icons';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import type { EntitlementsRow, HuntRow } from '../data/database.types';
import { listMyHunts } from '../data/hunts';
import { getMyEntitlements } from '../data/profile';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { cadenceWords, formatAgo } from '../lib/dates';
import { manifestLine } from '../lib/huntDraft';
import { nextPlan, planName } from '../lib/plans';
import { useAuth } from '../providers/AuthProvider';

/** "3 of 3 hunts · Traveler", the next plan up, and the bar (Hunts.dc.html). */
export function HuntUsage({ ent }: { ent: EntitlementsRow }) {
  const max = ent.max_active_hunts;
  const used = ent.hunts_active ?? 0;
  if (max === null) return null;
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100;
  const up = nextPlan(ent.tier);
  return (
    <div className="usage">
      <div className="usage__row">
        <span className="usage__count">
          {used} of {max} hunts · {planName(ent.tier)}
        </span>
        <Link to="/profile#plan">{up ? `Upgrade to ${planName(up)}` : 'Your plan'}</Link>
      </div>
      <div
        className="usage__bar"
        role="progressbar"
        aria-label="Active hunts used"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={used}
      >
        <div className="usage__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** One line of the manifest: number, name, what it reads as, when it last looked, and a status pill. */
function ManifestRow({ hunt, index, cadence, now }: { hunt: HuntRow; index: number; cadence: string; now: Date }) {
  const checked = formatAgo(hunt.last_run_at, now);
  const status = !hunt.active
    ? { text: 'Paused', tone: 'paused' }
    : hunt.match_count > 0
      ? { text: `${hunt.match_count} found`, tone: 'found' }
      : { text: 'Watching', tone: 'watching' };
  const note = !hunt.active
    ? 'Paused. Not checking for new lots.'
    : hunt.match_count > 0 && checked
      ? `Checked ${checked}`
      : `Nothing yet. Still looking, ${cadence}.`;
  return (
    <li className="manifest__row">
      <span className="manifest__num" aria-hidden="true">
        {String(index + 1).padStart(2, '0')}
      </span>
      <div className="manifest__text">
        <h2 className="manifest__name">
          <Link to={`/hunts/${hunt.id}`} className="manifest__link">
            {hunt.name}
          </Link>
        </h2>
        <span className="manifest__reads">{manifestLine(hunt)}</span>
        <span className="manifest__note">{note}</span>
        {!hunt.active && hunt.paused_reason ? <span className="notice notice--inline">{hunt.paused_reason}</span> : null}
      </div>
      <span className={`status-pill status-pill--${status.tone}`}>{status.text}</span>
    </li>
  );
}

export function HuntsPage() {
  useDocumentTitle('Hunts');
  const { user } = useAuth();
  const now = useNow(60_000);
  const hunts = useAsync(() => listMyHunts(user?.id ?? ''), [user?.id], Boolean(user));
  const ent = useAsync(() => getMyEntitlements(), [user?.id], Boolean(user));
  const cadence = cadenceWords(ent.data?.alert_latency_seconds ?? 3600);
  const list = hunts.data ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Hunts</h1>
        <Link to="/hunts/new" className="btn btn--primary btn--pill">
          <PlusIcon size={16} strokeWidth={2.4} />
          <span>New</span>
        </Link>
      </header>
      <p className="page-lead">What you are gathering. Each hunt keeps looking after you close the app.</p>

      {ent.data ? <HuntUsage ent={ent.data} /> : null}

      {hunts.loading && !hunts.data ? (
        <LoadingState label="Loading your hunts" />
      ) : hunts.error ? (
        <ErrorState error={hunts.error} onRetry={hunts.reload} title="Your hunts did not load" />
      ) : list.length === 0 ? (
        <EmptyState
          title="Nothing on the list yet"
          action={
            <Link to="/hunts/new" className="btn btn--primary">
              Start a hunt
            </Link>
          }
        >
          <p>
            Say what you need, the way you would tell a friend. Skeuos keeps looking {cadence} and tells you when one is
            listed.
          </p>
        </EmptyState>
      ) : (
        <section aria-label="Your hunts" className="manifest">
          <ol className="manifest__list">
            {list.map((h, i) => (
              <ManifestRow key={h.id} hunt={h} index={i} cadence={cadence} now={now} />
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="how" className="info-box">
        <h2 id="how" className="info-box__title">
          How hunts work
        </h2>
        <p>
          A hunt searches every source, including things nobody has listed yet. You get one summary of what exists today,
          then one alert for each new find.
        </p>
      </section>
    </div>
  );
}
