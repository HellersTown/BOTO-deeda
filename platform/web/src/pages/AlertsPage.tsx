import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalIcon } from '../components/Icons';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { listMyAlerts, markAlertRead, markAllAlertsRead } from '../data/alerts';
import type { AlertKind, AlertRow, Json } from '../data/database.types';
import { describeError } from '../data/errors';
import { listMyHunts } from '../data/hunts';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { formatRelativeTime } from '../lib/dates';
import { useAlerts } from '../providers/AlertsProvider';
import { useAuth } from '../providers/AuthProvider';

/**
 * The kind line above each alert, in the app's own words (Alerts.dc.html). The
 * title and body are the database's (0013) and are shown as written.
 */
const KIND: Readonly<Record<AlertKind, { label: string; tone: string }>> = {
  closing_soon: { label: 'Closing soon', tone: 'notice' },
  outbid: { label: 'Outbid', tone: 'accent' },
  hunt_match: { label: 'Found', tone: 'gov' },
  hunt_digest: { label: 'Found', tone: 'gov' },
  lot_sold: { label: 'Sold', tone: 'muted' },
  price_drop: { label: 'Price drop', tone: 'accent' },
  new_auction_nearby: { label: 'New nearby', tone: 'gov' },
};

/** "Found · Generator, up to $800": a hunt's alerts name the hunt when it is known. */
function kindLabel(alert: AlertRow, huntNames: ReadonlyMap<string, string>): string {
  const base = KIND[alert.kind].label;
  const hunt = alert.hunt_id ? huntNames.get(alert.hunt_id) : undefined;
  return (alert.kind === 'hunt_match' || alert.kind === 'hunt_digest') && hunt ? `${base} · ${hunt}` : base;
}

function payloadUrl(payload: Json | null): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const url = payload.url;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

/** Where tapping an alert goes (0013's kinds and payloads). */
function target(alert: AlertRow): string {
  switch (alert.kind) {
    case 'hunt_digest':
      return alert.hunt_id ? `/hunts/${alert.hunt_id}` : '/hunts';
    case 'outbid':
    case 'lot_sold':
      return '/bids?tab=' + (alert.kind === 'lot_sold' ? 'closed' : 'placed');
    default:
      return alert.lot_id ? `/lot/${alert.lot_id}` : alert.hunt_id ? `/hunts/${alert.hunt_id}` : '/alerts';
  }
}

export function AlertsPage() {
  useDocumentTitle('Alerts');
  const { user } = useAuth();
  const { version, refresh, unread } = useAlerts();
  const now = useNow();
  const alerts = useAsync(() => listMyAlerts(user?.id ?? ''), [user?.id], Boolean(user));
  const hunts = useAsync(() => listMyHunts(user?.id ?? ''), [user?.id], Boolean(user));
  const huntNames = new Map((hunts.data ?? []).map((h) => [h.id, h.name] as const));
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  // Realtime: reload when an alert arrives or changes elsewhere.
  const reload = alerts.reload;
  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

  const list = alerts.data ?? [];
  const unreadHere = list.filter((a) => a.read_at === null).length;

  function markOne(alert: AlertRow) {
    if (alert.read_at !== null) return;
    const at = new Date();
    alerts.setData((cur) => (cur ?? []).map((a) => (a.id === alert.id ? { ...a, read_at: at.toISOString() } : a)));
    markAlertRead(alert.id, at)
      .then(refresh)
      .catch((err: unknown) => setError(describeError(err)));
  }

  async function markAll() {
    if (!user) return;
    setMarking(true);
    setError(null);
    try {
      const at = new Date();
      await markAllAlertsRead(user.id, at);
      alerts.setData((cur) => (cur ?? []).map((a) => (a.read_at === null ? { ...a, read_at: at.toISOString() } : a)));
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="page page--flush">
      <header className="page-head page-head--padded">
        <h1 className="page-title">Alerts</h1>
        <button type="button" className="link-btn link-btn--strong" onClick={markAll} disabled={marking || (unreadHere === 0 && unread === 0)}>
          {marking ? 'Marking…' : 'Mark all read'}
        </button>
      </header>
      {error ? (
        <p className="field-error page-pad" role="alert">
          {error}
        </p>
      ) : null}

      {alerts.loading && !alerts.data ? (
        <LoadingState label="Loading alerts" />
      ) : alerts.error ? (
        <div className="page-pad">
          <ErrorState error={alerts.error} onRetry={alerts.reload} title="Alerts did not load" />
        </div>
      ) : list.length === 0 ? (
        <div className="page-pad">
          <EmptyState title="No alerts yet">
            <p>
              When a hunt finds something, or a lot you watch is about to close, is outbid or has sold, Skeuos tells you here.
            </p>
          </EmptyState>
        </div>
      ) : (
        <ul className="alert-list">
          {list.map((a) => {
            const kind = KIND[a.kind];
            const url = payloadUrl(a.payload);
            const isUnread = a.read_at === null;
            return (
              <li key={a.id} className={`alert${isUnread ? ' alert--unread' : ''}`}>
                <span className={isUnread ? 'alert__dot' : 'alert__dot alert__dot--read'} aria-hidden="true" />
                <div className="alert__main">
                  <Link to={target(a)} className="alert__link" onClick={() => markOne(a)}>
                    {isUnread ? <span className="visually-hidden">Unread. </span> : null}
                    <span className={`alert__kind alert__kind--${kind.tone}`}>{kindLabel(a, huntNames)}</span>
                    <span className="alert__title">{a.title ?? kind.label}</span>
                    {a.body ? <span className="alert__body">{a.body}</span> : null}
                  </Link>
                  <div className="alert__meta">
                    <time dateTime={a.created_at}>{formatRelativeTime(a.created_at, now)}</time>
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" className="alert__source">
                        Open listing <ExternalIcon size={14} strokeWidth={2} />
                        <span className="visually-hidden"> (opens in a new tab)</span>
                      </a>
                    ) : null}
                    {isUnread ? (
                      <button type="button" className="link-btn" onClick={() => markOne(a)}>
                        Mark read
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
