import { recommend, type RankedStrategy } from '@platform/strategy';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { BackIcon, ExternalIcon, PriceIcon, ShareIcon, TrailIcon, TruckIcon } from '../components/Icons';
import { LocationButton } from '../components/LocationDialog';
import type { LotLinkState } from '../components/LotCard';
import { Photo } from '../components/Photo';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { isWorthTheTrip, PriceTag, TierTag, WorthTheTrip } from '../components/Tags';
import { WalkAwayCalculator } from '../components/WalkAwayCalculator';
import type { WatchlistInsert } from '../data/database.types';
import { describeError } from '../data/errors';
import { getLotDetail, type LotDetail } from '../data/lots';
import { lookupPostalCodes } from '../data/postal';
import { getMyEntitlements } from '../data/profile';
import { getMyWatch, watchLot } from '../data/watchlist';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { describeCloseLong, formatShortDateTime, formatTimeIn, reminderInstant, DATE_ONLY_DEFAULT_ZONE } from '../lib/dates';
import { distanceWords, haversineMiles, isApproximateGeo } from '../lib/distance';
import { buildLotContext, factsFromDetail } from '../lib/lotContext';
import { formatCents, formatPercent, parseDollarsToCents, parsePercent } from '../lib/money';
import { planName } from '../lib/plans';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';

/** Evidence labels (docs/06 "Read this first") in plain words; PLACEHOLDER and UNVERIFIED read "unverified". */
function evidenceTag(s: RankedStrategy): { text: string; unverified: boolean } {
  if (s.placeholder || s.evidenceLabel === 'PLACEHOLDER' || s.evidenceLabel === 'UNVERIFIED') return { text: 'unverified', unverified: true };
  switch (s.evidenceLabel) {
    case 'SE':
      return { text: 'research-backed', unverified: false };
    case 'SE-2nd':
      return { text: 'secondary source', unverified: false };
    case 'INTERNAL':
      return { text: 'Skeuos data', unverified: false };
    default:
      return { text: 'Skeuos rule', unverified: false };
  }
}

function sellerLine(lot: LotDetail): string | null {
  const seller = lot.auction?.sellerName ?? lot.auction?.auctioneer ?? null;
  return seller ? `Sold by ${seller}` : null;
}

/** "Generac · GP7500E · specs from the listing". */
function specLine(lot: LotDetail): string | null {
  const parts = [lot.brand, lot.model, lot.condition].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} · specs from the listing` : null;
}

function bidLabel(lot: LotDetail): { cents: number | null; label: string } {
  if (lot.currentBidCents !== null) {
    const bids = lot.bidCount ?? 0;
    return {
      cents: lot.currentBidCents,
      label: bids === 0 ? 'opening bid, no bids yet' : `current bid · ${bids} ${bids === 1 ? 'bid' : 'bids'}`,
    };
  }
  if (lot.nextBidCents !== null) return { cents: lot.nextBidCents, label: 'to open the bidding' };
  return { cents: null, label: 'No price listed; check the listing' };
}

export function LotPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const home = useHome();
  const now = useNow();
  const link = (location.state ?? null) as LotLinkState | null;

  const lot = useAsync(() => getLotDetail(id), [id]);
  const detail = lot.data ?? null;
  useDocumentTitle(detail?.title ?? 'Lot');

  // Distance: search_lots' own figure when we came from search, else ZIP centroid to ZIP centroid.
  const lotZip = detail?.pickupPostalCode ?? null;
  const distance = useAsync(
    async () => {
      if (link?.distanceMiles !== null && link?.distanceMiles !== undefined) return link.distanceMiles;
      if (!home.place || !lotZip) return null;
      const found = (await lookupPostalCodes([lotZip])).get(lotZip);
      return found ? haversineMiles(home.place, found) : null;
    },
    [lotZip, home.place?.postalCode, link?.distanceMiles],
    detail !== null,
  );
  const distanceMiles = distance.data ?? null;
  // 0016: a point found from the city's centroid makes the distance approximate.
  const distanceApprox = link?.distanceApprox ?? isApproximateGeo(detail?.pickupGeoSource);

  const watch = useAsync(() => (user ? getMyWatch(user.id, id) : Promise.resolve(null)), [user?.id, id]);

  const [worthText, setWorthText] = useState('');
  const [cushionText, setCushionText] = useState('');
  const worthCents = parseDollarsToCents(worthText);
  const cushionPct = cushionText.trim() === '' ? null : parsePercent(cushionText);
  const minute = Math.floor(now.getTime() / 60_000);

  // Count the cost runs the engine's personal-use arm: what it is worth to you, less the cushion you keep.
  const rec = useMemo(
    () =>
      detail
        ? recommend(
            buildLotContext(factsFromDetail(detail), distanceMiles, {
              estimatedResaleCents: null,
              estimatedValueCents: worthCents,
              targetMarginPct: cushionPct,
              userGoal: 'use',
            }),
            new Date(minute * 60_000),
          )
        : null,
    [detail, distanceMiles, worthCents, cushionPct, minute],
  );

  const [saving, setSaving] = useState(false);
  const [watchMessage, setWatchMessage] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  if (lot.loading && !detail) return <LoadingState label="Loading the lot" />;
  if (lot.error) {
    return (
      <div className="page">
        <ErrorState error={lot.error} onRetry={lot.reload} title="This lot did not load" />
      </div>
    );
  }
  if (!detail || !rec) {
    return (
      <div className="page">
        <EmptyState title="We could not find that lot" action={<Link className="btn btn--secondary" to="/">Back to search</Link>}>
          <p>It may have been removed by the source. Lots stay listed here until the source drops them.</p>
        </EmptyState>
      </div>
    );
  }

  const sourceName = detail.source?.name ?? 'the source site';
  const bidUrl = detail.url ?? detail.auction?.url ?? null;
  const precise = detail.meta.closeTimePrecise;
  const timeZone = detail.auction?.timezone ?? null;
  const close = describeCloseLong({ closesAt: detail.closesAt, precision: precise ? 'precise' : 'date_only', timeZone, closed: detail.closed }, now);
  const watching = watch.data ?? null;
  const remindLead = watching?.remind_seconds_before ?? rec.timing?.alertSecondsBefore ?? 600;
  const reminder = reminderInstant({ closesAt: detail.closesAt, precise, timeZone, remindSecondsBefore: remindLead });
  const reminderText = reminder
    ? precise
      ? `${formatShortDateTime(reminder)}, ${Math.round(remindLead / 60)} minutes before it closes`
      : `${formatTimeIn(reminder, timeZone ?? DATE_ONLY_DEFAULT_ZONE)} that morning`
    : null;
  const bid = bidLabel(detail);
  const spec = specLine(detail);
  const seller = sellerLine(detail);
  const worth = isWorthTheTrip(detail.sleeperScore);
  const hammer = rec.walkAway.hammerCeilingCents;
  const numberReady = worthCents !== null && hammer !== null;
  const cityState = [detail.pickupCity, [detail.pickupState, detail.pickupPostalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const place = [detail.auction?.pickupLine1, cityState].filter(Boolean).join(', ');
  const premiumParam = rec.walkAway.parameters.find((p) => p.name === 'buyer_premium_pct');
  const premiumText =
    detail.auction?.buyerPremiumPct !== null && detail.auction?.buyerPremiumPct !== undefined
      ? `${formatPercent(detail.auction.buyerPremiumPct)} buyer’s premium`
      : premiumParam?.source.startsWith('platform default')
        ? `${formatPercent(rec.walkAway.rates.buyerPremiumPct)} buyer’s premium (the site’s usual terms)`
        : `premium not published; the count assumes ${formatPercent(rec.walkAway.rates.buyerPremiumPct)} (unverified)`;
  const terms = detail.meta.terms;

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: detail?.title ?? 'Lot', url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareNote('Link copied');
      }
    } catch {
      // The user closed the share sheet.
    }
  }

  async function watchAndRemind() {
    if (!user || !detail || !rec) return;
    setSaving(true);
    setWatchError(null);
    setWatchMessage(null);
    try {
      if (!watching) {
        // No trigger enforces max_watchlist, so this is the only check; if the
        // entitlements view cannot be read, watching still works.
        const ent = await getMyEntitlements().catch(() => null);
        if (ent && ent.max_watchlist !== null && (ent.watchlist_count ?? 0) >= ent.max_watchlist) {
          setWatchError(
            `Your ${planName(ent.tier)} plan holds ${ent.max_watchlist} watched lots, and all are in use. Remove one in Bids to watch this lot.`,
          );
          return;
        }
      }
      const payload: WatchlistInsert = { user_id: user.id, lot_id: detail.id };
      if (numberReady) payload.max_bid_cents = hammer;
      if (rec.timing?.alertSecondsBefore) payload.remind_seconds_before = rec.timing.alertSecondsBefore;
      const row = await watchLot(payload);
      watch.setData(row);
      setWatchMessage(
        numberReady
          ? `Watching. Your walk-away, ${formatCents(hammer ?? 0)}, is saved in Bids.`
          : 'Watching. Add what it is worth to you above to save a walk-away too.',
      );
    } catch (err) {
      setWatchError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const strategies = rec.strategies;
  const shown = strategies.slice(0, 3);
  const rest = strategies.slice(3);

  return (
    <div className="page page--lot">
      <header className="lot-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(link?.from ?? '/'))}
        >
          <BackIcon />
        </button>
        <span className="lot-head__source">{sourceName}</span>
        <button type="button" className="icon-btn" aria-label="Share lot" onClick={share}>
          <ShareIcon size={20} strokeWidth={2} />
        </button>
      </header>
      {shareNote ? (
        <p className="toast" role="status">
          {shareNote}
        </p>
      ) : null}

      <div className="lot-layout">
        <div className="lot-layout__media">
          {detail.imageUrls.length > 1 ? (
            <ul className="gallery" aria-label={`${detail.imageUrls.length} photos from the listing`}>
              {detail.imageUrls.map((src, i) => (
                <li key={src}>
                  <Photo src={src} alt={`${detail.title}, photo ${i + 1} of ${detail.imageUrls.length}`} className="lot-photo" />
                </li>
              ))}
            </ul>
          ) : (
            <Photo src={detail.imageUrls[0]} alt={detail.title} className="lot-photo" empty="No photo in the listing" />
          )}
        </div>

        <div className="lot-layout__main">
          <section className="lot-title">
            <div className="lot-title__meta">
              <TierTag tier={detail.source?.tier} />
              {seller ? <span className="lot-title__seller">{seller}</span> : null}
            </div>
            <h1 className="lot-title__name">{detail.title}</h1>
            {spec ? <p className="lot-title__spec">{spec}</p> : null}
            <div className="lot-title__price">
              {bid.cents !== null ? <PriceTag cents={bid.cents} size="lg" /> : null}
              <span className="lot-title__bids">{bid.label}</span>
              {worth ? <WorthTheTrip className="lot-title__worth" /> : null}
            </div>
            {worth && detail.sleeperReasons.length ? (
              <ul className="worth-reasons" aria-label="Why it may be worth the trip">
                {detail.sleeperReasons.map((r) => (
                  <li key={r.code}>{r.detail}</li>
                ))}
              </ul>
            ) : null}
          </section>

          <section aria-label="Closing time" className={`close-box close-box--${close.tone}`}>
            <strong>{close.headline}</strong>
            {close.countdown ? <> That is {close.countdown}.</> : null}
            {!precise && !detail.closed ? (
              <>
                {' '}
                {sourceName} publishes the date, not the hour
                {detail.meta.inactivityMinutes ? ', and a sale keeps extending while bids arrive' : ''}.
              </>
            ) : null}
            {!detail.closed && reminderText ? (
              <> {watching ? `We’ll remind you at ${reminderText}.` : `Watch it and we’ll remind you at ${reminderText}.`}</>
            ) : null}
          </section>

          <section aria-labelledby="trip" className="trip">
            <h2 id="trip" className="trip__title">
              The trip
            </h2>
            <div className="trip__row">
              <TrailIcon size={18} strokeWidth={2} className="trip__icon" />
              <span>
                {distanceMiles !== null && home.zip ? (
                  <>
                    <strong>{distanceWords(distanceMiles, distanceApprox)}</strong> from {home.zip}
                  </>
                ) : null}
                {distanceMiles !== null && home.zip && place ? ' · ' : ''}
                {place || (distanceMiles === null ? 'The listing gives no pickup address.' : '')}
                {!home.zip ? (
                  <span className="trip__set">
                    {' '}
                    <LocationButton variant="field" />
                  </span>
                ) : null}
              </span>
            </div>
            <div className="trip__row">
              <TruckIcon size={18} className="trip__icon" />
              <span>
                <strong>{detail.ships ? 'Ships' : 'Pickup only'}</strong>
                {detail.auction?.shipsNote ? ` · ${detail.auction.shipsNote}` : ''}
                {terms ? (
                  <details className="trip__terms">
                    <summary>Inspection and removal, from the listing</summary>
                    <p>{terms}</p>
                  </details>
                ) : null}
              </span>
            </div>
            <div className="trip__row">
              <PriceIcon size={18} className="trip__icon" />
              <span>
                <strong>Fees</strong> · {premiumText}
                {detail.auction?.buyerPremiumNote ? ` · ${detail.auction.buyerPremiumNote}` : ''}
                {detail.meta.feeNote ? ` · Also disclosed: ${detail.meta.feeNote}` : ''}
                {detail.auction?.termsUrl ? (
                  <>
                    {' · '}
                    <a href={detail.auction.termsUrl} target="_blank" rel="noopener noreferrer">
                      Read the auction terms
                    </a>
                  </>
                ) : null}
              </span>
            </div>
          </section>

          <WalkAwayCalculator
            rec={rec}
            worthText={worthText}
            onWorthText={setWorthText}
            cushionText={cushionText}
            onCushionText={setCushionText}
            distanceMiles={distanceMiles}
            distanceApprox={distanceApprox}
            homeZip={home.zip}
          />

          <section aria-labelledby="plan" className="plan">
            <h2 id="plan" className="plan__title">
              The plan for this lot
            </h2>
            <ul className="plan__list">
              {rec.timing ? <li>{rec.timing.instruction}</li> : null}
              {shown.map((s) => {
                const tag = evidenceTag(s);
                return (
                  <li key={s.id}>
                    {s.displayAs === 'cross-check' ? 'Cross-check: ' : ''}
                    {s.message}{' '}
                    <span className={`tag ${tag.unverified ? 'tag--unverified' : 'tag--evidence'}`}>{tag.text}</span>
                  </li>
                );
              })}
            </ul>
            {rest.length > 0 ? (
              <details className="plan__more">
                <summary>
                  {rest.length} more {rest.length === 1 ? 'strategy applies' : 'strategies apply'}
                </summary>
                <ul className="plan__list">
                  {rest.map((s) => {
                    const tag = evidenceTag(s);
                    return (
                      <li key={s.id}>
                        <strong>{s.name}.</strong> {s.message}{' '}
                        <span className={`tag ${tag.unverified ? 'tag--unverified' : 'tag--evidence'}`}>{tag.text}</span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ) : null}
            {!precise ? <p className="plan__note">{rec.explanation.find((l) => l.startsWith('The source publishes only a close DATE')) ?? ''}</p> : null}
          </section>

          <div className="lot-actions">
            {bidUrl ? (
              <a className="btn btn--primary btn--large" href={bidUrl} target="_blank" rel="noopener noreferrer">
                <span>Bid on {sourceName}</span>
                <ExternalIcon size={16} strokeWidth={2.2} />
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : (
              <p className="muted small">The source did not publish a link for this lot.</p>
            )}
            {!user ? (
              <Link className="btn btn--outline btn--tall" to={`/signin?next=${encodeURIComponent(`/lot/${detail.id}`)}`}>
                Watch and remind me
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn--outline btn--tall"
                onClick={watchAndRemind}
                disabled={saving || detail.closed || (watching !== null && (!numberReady || watching.max_bid_cents === hammer))}
              >
                {saving
                  ? 'Saving…'
                  : watching
                    ? numberReady && watching.max_bid_cents !== hammer
                      ? 'Save my new walk-away'
                      : 'Watching this lot'
                    : 'Watch and remind me'}
              </button>
            )}
            {watchMessage ? (
              <p className="form-note" role="status">
                {watchMessage} <Link to="/bids">Open Bids</Link>
              </p>
            ) : watching && !watchError ? (
              <p className="form-note">
                {watching.max_bid_cents !== null
                  ? `Your saved walk-away is ${formatCents(watching.max_bid_cents)}.`
                  : 'No walk-away saved yet.'}{' '}
                <Link to="/bids">Open Bids</Link>
              </p>
            ) : null}
            {watchError ? (
              <p className="field-error" role="alert">
                {watchError}
              </p>
            ) : null}
            <p className="muted small">Skeuos never bids for you. The button opens the lot on {sourceName}, where you place the bid.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
