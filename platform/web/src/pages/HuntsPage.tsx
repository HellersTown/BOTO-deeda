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
import { summarizeHunt } from '../lib/huntDraft';
import { useAuth } from '../providers/AuthProvider';

export function HuntUsage({ ent }: { ent: EntitlementsRow }) {
  const max = ent.max_active_hunts;
  const used = ent.hunts_active ?? 0;
  if (max === null) return null;
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100;
  return (
    <div className="usage">
      <div className="usage__row">
        <span className="usage__count">
          {used} of {max} hunts
        </span>
        <Link to="/profile#plan">{ent.label ?? 'Your'} plan · upgrade</Link>
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

function HuntCard({ hunt, cadence, now }: { hunt: HuntRow; cadence: string; now: Date }) {
  const checked = formatAgo(hunt.last_run_at, now);
  return (
    <article className="card hunt-card">
      <div className="hunt-card__head">
        <h2 className="hunt-card__name">
          <Link to={`/hunts/${hunt.id}`}>{hunt.name}</Link>
        </h2>
        <span className={`status ${hunt.active ? 'status--active' : 'status--paused'}`}>{hunt.active ? 'Active' : 'Paused'}</span>
      </div>
      <p className="hunt-card__summary">{summarizeHunt(hunt)}</p>
      {!hunt.active && hunt.paused_reason ? <p className="notice notice--inline">{hunt.paused_reason}</p> : null}
      <div className="hunt-card__foot">
        {hunt.match_count > 0 ? (
          <Link to={`/hunts/${hunt.id}`} className="hunt-card__matches">
            {hunt.match_count} {hunt.match_count === 1 ? 'match' : 'matches'}
          </Link>
        ) : (
          <span className="hunt-card__matches">No matches yet</span>
        )}
        <span className="muted small">
          {!hunt.active
            ? 'Not checking while paused'
            : hunt.match_count > 0 && checked
              ? `Checked ${checked}`
              : `Still looking, ${cadence}`}
        </span>
      </div>
    </article>
  );
}

export function HuntsPage() {
  useDocumentTitle('Hunts');
  const { user } = useAuth();
  const now = useNow(60_000);
  const hunts = useAsync(() => listMyHunts(user?.id ?? ''), [user?.id], Boolean(user));
  const ent = useAsync(() => getMyEntitlements(), [user?.id], Boolean(user));
  const cadence = cadenceWords(ent.data?.alert_latency_seconds ?? 3600);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Hunts</h1>
        <Link to="/hunts/new" className="btn btn--primary btn--pill">
          <PlusIcon size={16} strokeWidth={2.4} />
          <span>New</span>
        </Link>
      </header>

      {ent.data ? <HuntUsage ent={ent.data} /> : null}

      {hunts.loading && !hunts.data ? (
        <LoadingState label="Loading your hunts" />
      ) : hunts.error ? (
        <ErrorState error={hunts.error} onRetry={hunts.reload} title="Your hunts did not load" />
      ) : (hunts.data ?? []).length === 0 ? (
        <EmptyState
          title="No hunts yet"
          action={
            <Link to="/hunts/new" className="btn btn--primary">
              Start a hunt
            </Link>
          }
        >
          <p>
            Describe something you want, the way you would to a friend. Skeuos keeps looking {cadence} and alerts you when a
            match is listed.
          </p>
        </EmptyState>
      ) : (
        <div className="stack">
          {(hunts.data ?? []).map((h) => (
            <HuntCard key={h.id} hunt={h} cadence={cadence} now={now} />
          ))}
        </div>
      )}

      <section aria-labelledby="how" className="info-box">
        <h2 id="how" className="info-box__title">
          How hunts work
        </h2>
        <p>
          A hunt keeps searching every monitored site after you close the app, including items nobody has listed yet. You get
          one summary for what already exists and a single alert for each new match.
        </p>
      </section>
    </div>
  );
}
