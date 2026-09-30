import { Link } from 'react-router-dom';
import type { EntitlementsRow } from '../data/database.types';
import { nextPlan, planName } from '../lib/plans';

/**
 * Shown when the hunts trigger (0003/0004) refuses a hunt over the plan limit.
 * With the plan known it says so in the app's own words; otherwise it shows the
 * trigger's message (`message`).
 */
export function UpgradePrompt({
  ent,
  message,
  onDismiss,
}: {
  ent?: Pick<EntitlementsRow, 'tier' | 'max_active_hunts'> | null;
  message: string | null;
  onDismiss?: () => void;
}) {
  const known = ent && ent.max_active_hunts !== null;
  const next = nextPlan(ent?.tier);
  return (
    <section className="upgrade" role="alert" aria-labelledby="upgrade-title">
      <h2 id="upgrade-title" className="upgrade__title">
        Every hunt on your plan is in use
      </h2>
      {known ? (
        <p className="upgrade__detail">
          {planName(ent.tier)} keeps watch on {ent.max_active_hunts} {ent.max_active_hunts === 1 ? 'hunt' : 'hunts'} at a time.
        </p>
      ) : message ? (
        <p className="upgrade__detail">{message}</p>
      ) : null}
      <p>
        Pause a hunt you can do without and this one can start.
        {next ? ` ${planName(next)} keeps watch on more, and faster; plans are not for sale yet.` : ''}
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
