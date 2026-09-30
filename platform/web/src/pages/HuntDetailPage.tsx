import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { BackIcon } from '../components/Icons';
import { LotCard } from '../components/LotCard';
import { CardSkeletons, EmptyState, ErrorState, LoadingState } from '../components/States';
import { UpgradePrompt } from '../components/UpgradePrompt';
import { DataError, describeError } from '../data/errors';
import { deleteHunt, dismissHuntMatch, getHunt, listHuntMatches, renameHunt, runMyHunt, setHuntActive } from '../data/hunts';
import { getMyEntitlements } from '../data/profile';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { cadenceWords, formatAgo } from '../lib/dates';
import { summarizeHunt } from '../lib/huntDraft';
import { useAuth } from '../providers/AuthProvider';

export function HuntDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const created = (location.state as { created?: boolean; note?: string | null } | null) ?? null;
  const { user } = useAuth();
  const now = useNow();
  const hunt = useAsync(() => getHunt(id), [id]);
  const matches = useAsync(() => listHuntMatches(id), [id]);
  const ent = useAsync(() => getMyEntitlements(), [user?.id], Boolean(user));
  useDocumentTitle(hunt.data?.name ?? 'Hunt');

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(created?.note ?? null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');

  if (hunt.loading && !hunt.data) return <LoadingState label="Loading the hunt" />;
  if (hunt.error) {
    return (
      <div className="page">
        <ErrorState error={hunt.error} onRetry={hunt.reload} title="This hunt did not load" />
      </div>
    );
  }
  const h = hunt.data;
  if (!h) {
    return (
      <div className="page">
        <EmptyState title="Hunt not found" action={<Link className="btn btn--secondary" to="/hunts">Back to hunts</Link>}>
          <p>It may have been deleted.</p>
        </EmptyState>
      </div>
    );
  }
  const cadence = cadenceWords(ent.data?.alert_latency_seconds ?? 3600);
  const checked = formatAgo(h.last_run_at, now);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setMessage(null);
    setLimit(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof DataError && err.kind === 'hunt_limit') setLimit(err.detail);
      else setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  const toggleActive = () =>
    act('toggle', async () => {
      const next = await setHuntActive(h.id, !h.active);
      hunt.setData(next);
      if (next.active) {
        const run = await runMyHunt(h.id);
        matches.reload();
        hunt.reload();
        setMessage(run.newMatches > 0 ? `Resumed. ${run.newMatches} new ${run.newMatches === 1 ? 'match' : 'matches'} found.` : 'Resumed.');
      } else {
        setMessage('Paused. This hunt is not checking for new lots until you resume it.');
      }
    });

  const checkNow = () =>
    act('check', async () => {
      const run = await runMyHunt(h.id);
      matches.reload();
      hunt.reload();
      setMessage(
        run.skippedEmpty
          ? 'This hunt has nothing to look for. Add words or a brand in a new hunt.'
          : run.newMatches > 0
            ? `${run.newMatches} new ${run.newMatches === 1 ? 'match' : 'matches'} found.`
            : 'Checked just now. Nothing new yet.',
      );
    });

  const remove = () =>
    act('delete', async () => {
      await deleteHunt(h.id);
      navigate('/hunts', { replace: true });
    });

  const dismiss = (matchId: number) =>
    act(`dismiss-${matchId}`, async () => {
      await dismissHuntMatch(matchId);
      matches.setData((cur) => (cur ?? []).filter((m) => m.id !== matchId));
    });

  const rename = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void act('rename', async () => {
      hunt.setData(await renameHunt(h.id, name));
      setRenaming(false);
    });
  };

  const list = matches.data ?? [];
  const open = list.filter((m) => !m.lot.closed);
  const closed = list.filter((m) => m.lot.closed);

  return (
    <div className="page">
      <header className="page-head page-head--detail">
        <Link to="/hunts" className="icon-btn" aria-label="Back to hunts">
          <BackIcon />
        </Link>
        <span className={`status ${h.active ? 'status--active' : 'status--paused'}`}>{h.active ? 'Active' : 'Paused'}</span>
      </header>

      <section className="hunt-detail">
        {renaming ? (
          <form className="rename" onSubmit={rename}>
            <label htmlFor="rename" className="visually-hidden">
              Hunt name
            </label>
            <input id="rename" className="input" value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" className="btn btn--primary btn--small" disabled={busy !== null}>
              Save
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h1 className="page-title">{h.name}</h1>
        )}
        <p className="hunt-card__summary">{summarizeHunt(h)}</p>
        {h.query_text ? <p className="muted small">You asked for: “{h.query_text}”</p> : null}
        {!h.active && h.paused_reason ? <p className="notice notice--inline">{h.paused_reason}</p> : null}
        <p className="muted small">
          {h.active ? `Checks ${cadence}` : 'Paused: not checking for new lots'}
          {checked ? ` · last checked ${checked}` : ''}
        </p>

        <div className="button-row">
          <button type="button" className="btn btn--outline btn--small" onClick={toggleActive} disabled={busy !== null}>
            {busy === 'toggle' ? 'Saving…' : h.active ? 'Pause' : 'Resume'}
          </button>
          {h.active ? (
            <button type="button" className="btn btn--outline btn--small" onClick={checkNow} disabled={busy !== null}>
              {busy === 'check' ? 'Checking…' : 'Check now'}
            </button>
          ) : null}
          {!renaming ? (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => {
                setNewName(h.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
          ) : null}
          {confirmDelete ? (
            <>
              <button type="button" className="btn btn--danger btn--small" onClick={remove} disabled={busy !== null}>
                {busy === 'delete' ? 'Deleting…' : 'Delete this hunt'}
              </button>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--ghost btn--small btn--danger-text" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
        {message ? (
          <p className="form-note" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {limit !== null ? <UpgradePrompt message={limit} onDismiss={() => setLimit(null)} /> : null}
      </section>

      <section aria-labelledby="matches-title" className="matches">
        <h2 id="matches-title" className="section-title">
          {matches.data ? `${open.length} open ${open.length === 1 ? 'match' : 'matches'}` : 'Matches'}
        </h2>
        {matches.loading && !matches.data ? (
          <CardSkeletons count={2} />
        ) : matches.error ? (
          <ErrorState error={matches.error} onRetry={matches.reload} title="Matches did not load" />
        ) : list.length === 0 ? (
          <EmptyState title="No matches yet">
            <p>
              {h.active
                ? `This hunt keeps looking ${cadence}, across every monitored site, including lots nobody has listed yet. You will get an alert when a match is listed.`
                : 'This hunt is paused. Resume it to keep looking.'}
            </p>
          </EmptyState>
        ) : (
          <ul className="lot-grid" aria-label="Matches">
            {[...open, ...closed].map((m) => (
              <li key={m.id}>
                <LotCard
                  lot={m.lot}
                  now={now}
                  from={`/hunts/${h.id}`}
                  footer={
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => dismiss(m.id)}
                      disabled={busy !== null}
                      aria-label={`Dismiss ${m.lot.title}`}
                    >
                      Dismiss
                    </button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
