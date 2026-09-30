import { Link } from 'react-router-dom';

/** Shown when the hunts trigger (0003/0004) refuses a hunt over the plan limit. */
export function UpgradePrompt({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  return (
    <section className="upgrade" role="alert" aria-labelledby="upgrade-title">
      <h2 id="upgrade-title" className="upgrade__title">
        Your plan’s hunts are all in use
      </h2>
      {message ? <p className="upgrade__detail">{message}</p> : null}
      <p>
        Pause a hunt you can do without and this one can start. Plans with more hunts and faster alerts are coming soon;
        there is no billing yet.
      </p>
      <div className="upgrade__actions">
        <Link className="btn btn--primary btn--small" to="/hunts">
          Manage hunts
        </Link>
        <Link className="btn btn--secondary btn--small" to="/profile#plan">
          Compare plans
        </Link>
        {onDismiss ? (
          <button type="button" className="btn btn--ghost btn--small" onClick={onDismiss}>
            Not now
          </button>
        ) : null}
      </div>
    </section>
  );
}
