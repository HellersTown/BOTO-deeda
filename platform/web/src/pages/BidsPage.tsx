import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClosePill } from '../components/ClosePill';
import { Photo } from '../components/Photo';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import type { WatchOutcome, WatchlistRow, WatchlistUpdate } from '../data/database.types';
import { describeError } from '../data/errors';
import { readLotMeta } from '../data/lots';
import { lookupPostalCodes } from '../data/postal';
import { listMyWatchlist, removeWatch, updateWatch, type WatchEntry, type WatchedLot } from '../data/watchlist';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { formatShortDateTime, reminderInstant } from '../lib/dates';
import { haversineMiles } from '../lib/distance';
import { summarizeExposure, type ExposureLine } from '../lib/exposure';
import { buildLotContext, factsFromWatched } from '../lib/lotContext';
import { formatCents, formatMaybeCents, parseDollarsToCents } from '../lib/money';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';

type TabKey = 'watching' | 'placed' | 'closed';
const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'watching', label: 'Watching' },
  { key: 'placed', label: 'Bid placed' },
  { key: 'closed', label: 'Closed' },
];

function tabOf(entry: WatchEntry): TabKey {
  if (entry.watch.outcome !== null || entry.lot?.closed) return 'closed';
  return entry.watch.placed_bid ? 'placed' : 'watching';
}

function isOutcome(v: string | null): v is WatchOutcome {
  return v === 'won' || v === 'lost' || v === 'passed';
}

function ReminderPill({ watch, lot, now }: { watch: WatchlistRow; lot: WatchedLot; now: Date }) {
  if (watch.reminded_at) {
    return <span className="pill pill--muted">Reminded {formatShortDateTime(new Date(watch.reminded_at))}</span>;
  }
  const at = reminderInstant({
    closesAt: lot.closesAt,
    precise: readLotMeta(lot.meta).closeTimePrecise,
    timeZone: lot.timeZone,
    remindSecondsBefore: watch.remind_seconds_before,
  });
  if (!at || at.getTime() <= now.getTime()) return null;
  return <span className="pill pill--notice">Reminder {formatShortDateTime(at)}</span>;
}

function PlacedBidForm({ initial, onSave, onCancel }: { initial: number | null; onSave: (cents: number) => Promise<void>; onCancel: () => void }) {
  const id = useId();
  const [text, setText] = useState(initial === null ? '' : formatCents(initial));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseDollarsToCents(text);
    if (cents === null || cents <= 0) {
      setError('Enter the maximum you bid, in dollars.');
      return;
    }
    setSaving(true);
    try {
      await onSave(cents);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <label htmlFor={id}>The maximum you entered on the site</label>
      <div className="inline-form__row">
        <input id={id} className="input" inputMode="decimal" value={text} placeholder="$" onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn--primary btn--small" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function WatchCard({
  entry,
  tab,
  now,
  onUpdate,
  onRemove,
}: {
  entry: WatchEntry;
  tab: TabKey;
  now: Date;
  onUpdate: (patch: WatchlistUpdate) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const { watch, lot } = entry;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!lot) return null;
  const precise = readLotMeta(lot.meta).closeTimePrecise;
  const place = [lot.sourceName, [lot.city, lot.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const outbid = watch.placed_bid && watch.placed_bid_cents !== null && lot.currentBidCents !== null && lot.currentBidCents > watch.placed_bid_cents;
  const finalCents = lot.soldPriceCents ?? lot.currentBidCents;

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <article className="card watch-card">
      <Link to={`/lot/${lot.id}`} className="watch-card__link">
        <Photo src={lot.imageUrl} alt="" className="watch-card__photo" />
        <div className="watch-card__text">
          <h2 className="watch-card__title">{lot.title}</h2>
          <span className="muted small">{place}</span>
          {tab === 'closed' ? null : (
            <span className="watch-card__pills">
              <ClosePill closesAt={lot.closesAt} precision={precise ? 'precise' : 'date_only'} timeZone={lot.timeZone} now={now} />
              <ReminderPill watch={watch} lot={lot} now={now} />
            </span>
          )}
        </div>
      </Link>

      <dl className="figures">
        <div className="figure">
          <dt>{tab === 'closed' ? 'Final price' : 'Current bid'}</dt>
          <dd>{formatMaybeCents(tab === 'closed' ? finalCents : lot.currentBidCents, '—')}</dd>
        </div>
        {watch.placed_bid ? (
          <div className="figure">
            <dt>Your bid</dt>
            <dd>{formatMaybeCents(watch.placed_bid_cents, '—')}</dd>
          </div>
        ) : null}
        <div className="figure">
          <dt>Your walk-away</dt>
          <dd className="figure--accent">
            {watch.max_bid_cents !== null ? formatCents(watch.max_bid_cents) : <Link to={`/lot/${lot.id}`}>Set it</Link>}
          </dd>
        </div>
      </dl>

      {outbid && tab === 'placed' ? (
        <p className="notice notice--inline">
          Outbid: the current bid is {formatCents(lot.currentBidCents ?? 0)}. Raise it only if your walk-away number allows.
        </p>
      ) : null}
      {watch.placed_bid && watch.max_bid_cents !== null && watch.placed_bid_cents !== null && watch.placed_bid_cents > watch.max_bid_cents ? (
        <p className="notice notice--inline">You bid above your walk-away number.</p>
      ) : null}

      {tab === 'watching' ? (
        editing ? (
          <PlacedBidForm
            initial={null}
            onCancel={() => setEditing(false)}
            onSave={async (cents) => {
              await onUpdate({ placed_bid: true, placed_bid_cents: cents });
              setEditing(false);
            }}
          />
        ) : (
          <button type="button" className="btn btn--outline btn--block" onClick={() => setEditing(true)}>
            I placed my bid
          </button>
        )
      ) : null}

      {tab === 'placed' ? (
        editing ? (
          <PlacedBidForm
            initial={watch.placed_bid_cents}
            onCancel={() => setEditing(false)}
            onSave={async (cents) => {
              await onUpdate({ placed_bid: true, placed_bid_cents: cents });
              setEditing(false);
            }}
          />
        ) : (
          <div className="button-row">
            <button type="button" className="btn btn--outline btn--small" onClick={() => setEditing(true)}>
              Change my bid
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => void run(() => onUpdate({ placed_bid: false, placed_bid_cents: null }))}>
              I did not bid
            </button>
          </div>
        )
      ) : null}

      {tab === 'closed' ? (
        <div className="outcome" role="group" aria-label="How did it go?">
          <span className="small muted">How did it go?</span>
          {(['won', 'lost', 'passed'] as const).map((o) => (
            <button
              key={o}
              type="button"
              className="chip"
              aria-pressed={watch.outcome === o}
              onClick={() => void run(() => onUpdate({ outcome: o }))}
            >
              {o === 'won' ? 'Won' : o === 'lost' ? 'Lost' : 'Passed'}
            </button>
          ))}
          {!isOutcome(watch.outcome) ? <span className="small muted">Recording it improves your numbers.</span> : null}
        </div>
      ) : null}

      <div className="watch-card__foot">
        <button type="button" className="link-btn" onClick={() => void run(onRemove)}>
          Stop watching
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function BidsPage() {
  useDocumentTitle('Bids');
  const { user } = useAuth();
  const home = useHome();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const tab: TabKey = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'watching') as TabKey;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const list = useAsync(() => listMyWatchlist(user?.id ?? ''), [user?.id], Boolean(user));
  const entries = useMemo(() => list.data ?? [], [list.data]);
  const zips = useMemo(
    () => [...new Set(entries.map((e) => e.lot?.postalCode).filter((z): z is string => Boolean(z)))].sort(),
    [entries],
  );
  const centroids = useAsync(() => lookupPostalCodes(zips), [zips.join(','), home.place?.postalCode], zips.length > 0 && home.place !== null);

  const grouped = useMemo(() => {
    const g: Record<TabKey, WatchEntry[]> = { watching: [], placed: [], closed: [] };
    for (const e of entries) if (e.lot) g[tabOf(e)].push(e);
    return g;
  }, [entries]);

  // "If every bid wins, you owe": the engine's portfolioExposure over open lots with a number.
  const exposure = useMemo(() => {
    const lines: ExposureLine[] = [];
    let missing = 0;
    for (const e of [...grouped.watching, ...grouped.placed]) {
      const lot = e.lot as WatchedLot;
      const hammer = e.watch.placed_bid && e.watch.placed_bid_cents !== null ? e.watch.placed_bid_cents : e.watch.max_bid_cents;
      if (hammer === null || hammer <= 0) {
        missing += 1;
        continue;
      }
      const there = lot.postalCode ? centroids.data?.get(lot.postalCode) : undefined;
      const miles = home.place && there ? haversineMiles(home.place, there) : null;
      lines.push({ lotId: lot.id, context: buildLotContext(factsFromWatched(lot), miles), hammerCents: hammer, siteKey: lot.auctionId });
    }
    return { summary: summarizeExposure(lines), missing, priced: lines.length };
  }, [grouped, centroids.data, home.place]);

  async function update(id: number, patch: WatchlistUpdate) {
    const row = await updateWatch(id, patch);
    list.setData((cur) => (cur ?? []).map((e) => (e.watch.id === id ? { ...e, watch: row } : e)));
  }
  async function remove(id: number) {
    await removeWatch(id);
    list.setData((cur) => (cur ?? []).filter((e) => e.watch.id !== id));
  }

  function selectTab(key: TabKey) {
    const next = new URLSearchParams(params);
    next.set('tab', key);
    setParams(next, { replace: true });
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.key === tab);
    let j = i;
    if (event.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') j = 0;
    else if (event.key === 'End') j = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[j];
    if (target) {
      selectTab(target.key);
      tabRefs.current[j]?.focus();
    }
  }

  const current = grouped[tab];
  const openCount = grouped.watching.length + grouped.placed.length;
  const r = exposure.summary.result;

  return (
    <div className="page">
      <header className="page-head page-head--stack">
        <h1 className="page-title">Bids</h1>
        <div role="tablist" aria-label="Bid status" className="segmented" onKeyDown={onTabKey}>
          {TABS.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`panel-${t.key}`}
              tabIndex={tab === t.key ? 0 : -1}
              className="segmented__tab"
              onClick={() => selectTab(t.key)}
            >
              {t.label}
              {grouped[t.key].length > 0 ? ` ${grouped[t.key].length}` : ''}
            </button>
          ))}
        </div>
      </header>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="stack">
        {list.loading && !list.data ? (
          <LoadingState label="Loading your bids" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} title="Your bids did not load" />
        ) : current.length === 0 ? (
          <EmptyState
            title={tab === 'watching' ? 'Nothing watched yet' : tab === 'placed' ? 'No bids recorded' : 'Nothing closed yet'}
            action={
              tab === 'watching' ? (
                <Link to="/" className="btn btn--secondary">
                  Find a lot
                </Link>
              ) : undefined
            }
          >
            <p>
              {tab === 'watching'
                ? 'Open a lot and tap “Watch and remind me”. Skeuos reminds you before it closes and keeps your walk-away number here.'
                : tab === 'placed'
                  ? 'When you bid on the source site, tap “I placed my bid” on a watched lot so Skeuos can warn you if you are outbid.'
                  : 'Watched lots move here when they close. Record whether you won so your numbers improve.'}
            </p>
          </EmptyState>
        ) : (
          current.map((e) => (
            <WatchCard
              key={e.watch.id}
              entry={e}
              tab={tab}
              now={now}
              onUpdate={(patch) => update(e.watch.id, patch)}
              onRemove={() => remove(e.watch.id)}
            />
          ))
        )}

        {openCount > 0 && tab !== 'closed' ? (
          <section className="exposure" aria-label="What you would owe">
            <div className="exposure__row">
              <span>If every bid wins, you owe</span>
              <span className="exposure__total">{exposure.priced > 0 ? formatCents(r.exposureCents) : '—'}</span>
            </div>
            <p className="exposure__note">
              {exposure.priced > 0
                ? `${r.liveBids} ${r.liveBids === 1 ? 'lot' : 'lots'}: premium, tax, card fee and one pickup trip per site included` +
                  `${r.transportCents > 0 ? ` (${formatCents(r.transportCents)} of trips)` : ''}. Rates the lot does not publish use unverified defaults.`
                : 'Add a walk-away number to a watched lot to see what you would owe.'}
              {exposure.summary.outbid > 0 ? ` ${exposure.summary.outbid} already above your number ${exposure.summary.outbid === 1 ? 'is' : 'are'} left out.` : ''}
              {exposure.summary.noTrip > 0 ? ` Pickup is not counted for ${exposure.summary.noTrip} with no known distance.` : ''}
              {exposure.missing > 0 && exposure.priced > 0 ? ` ${exposure.missing} without a number ${exposure.missing === 1 ? 'is' : 'are'} not counted.` : ''}
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
