import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { WatchlistRow } from '../data/database.types';
import { describeError } from '../data/errors';
import type { LotDetail } from '../data/lots';
import { getMyEntitlements } from '../data/profile';
import { watchLot } from '../data/watchlist';
import type { AsyncState } from '../hooks/useAsync';
import { useNow } from '../hooks/useNow';
import { describeCloseLong, reminderWords } from '../lib/dates';
import { distanceWords } from '../lib/distance';
import { formatPercent } from '../lib/money';
import { watchlistFullMessage } from '../lib/plans';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';
import { ExternalIcon, PriceIcon, TrailIcon, TruckIcon } from './Icons';
import { LocationButton } from './LocationDialog';
import { LotHead } from './LotHead';
import { Photo } from './Photo';
import { SaleTag, TierTag } from './Tags';

export interface SaleDetailProps {
  readonly detail: LotDetail;
  /** One-way miles from the home ZIP, or null when unknown. */
  readonly distanceMiles: number | null;
  /** The distance was measured to a city's centroid (0016), so it is approximate. */
  readonly distanceApprox: boolean;
  /** Where "back" goes when the page was opened directly. */
  readonly from: string | null;
  /** The user's watchlist row for this sale: null when it is not watched, or no one is signed in. */
  readonly watch: AsyncState<WatchlistRow | null>;
}

/**
 * The lot page for a sale-level row (0023): a whole sale from a source that
 * lists sales, not lots. It shows what the listing says about the sale (what
 * is in it, when it closes, where it is and who is selling) and opens the sale
 * on the source. With no price there is no price tag, bid count, Count the cost
 * or plan. Watch stays: its reminder needs only the close.
 */
export function SaleDetail({ detail, distanceMiles, distanceApprox, from, watch }: SaleDetailProps) {
  const { user } = useAuth();
  const home = useHome();
  const now = useNow();
  const [saving, setSaving] = useState(false);
  const [watchMessage, setWatchMessage] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  const sourceName = detail.source?.name ?? 'the source site';
  const saleUrl = detail.url ?? detail.auction?.url ?? null;
  const precise = detail.meta.closeTimePrecise;
  const timeZone = detail.auction?.timezone ?? null;
  const close = describeCloseLong({ closesAt: detail.closesAt, precision: precise ? 'precise' : 'date_only', timeZone, closed: detail.closed }, now);
  const watching = watch.data ?? null;
  const reminderText = reminderWords({ closesAt: detail.closesAt, precise, timeZone, remindSecondsBefore: watching?.remind_seconds_before ?? 600 });
  const seller = detail.auction?.sellerName ?? detail.auction?.auctioneer ?? null;
  const description = detail.description?.trim() || null;
  const cityState = [detail.pickupCity, [detail.pickupState, detail.pickupPostalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const place = [detail.auction?.pickupLine1, cityState].filter(Boolean).join(', ');
  const terms = detail.meta.terms;
  const shipsNote = detail.auction?.shipsNote ?? null;
  // Only what the listing publishes: no engine default stands in for a missing premium here.
  const premiumPct = detail.auction?.buyerPremiumPct ?? null;
  const premiumNote = detail.auction?.buyerPremiumNote ?? null;
  const termsUrl = detail.auction?.termsUrl ?? null;

  async function watchSale() {
    if (!user) return;
    setSaving(true);
    setWatchError(null);
    setWatchMessage(null);
    try {
      if (!watching) {
        // If the entitlements view cannot be read, watching still works.
        const full = watchlistFullMessage(await getMyEntitlements().catch(() => null), 'sale');
        if (full) {
          setWatchError(full);
          return;
        }
      }
      // No walk-away: a sale has no price to set one against.
      const row = await watchLot({ user_id: user.id, lot_id: detail.id });
      watch.setData(row);
      setWatchMessage('Watching. It is saved in Bids.');
    } catch (err) {
      setWatchError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page page--lot page--sale">
      <LotHead sourceName={sourceName} title={detail.title} from={from} shareLabel="Share sale" />

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
              {seller ? <span className="lot-title__seller">Sold by {seller}</span> : null}
            </div>
            <h1 className="lot-title__name">{detail.title}</h1>
            <div className="lot-title__sale">
              <SaleTag lotCount={detail.saleLotCount} size="lg" />
            </div>
          </section>

          <section aria-label="Closing time" className={`close-box close-box--${close.tone}`}>
            <strong>{detail.closed ? 'This sale has closed.' : close.headline}</strong>
            {close.countdown ? <> That is {close.countdown}.</> : null}
            {!precise && !detail.closed ? <> {sourceName} publishes the date, not the hour.</> : null}
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
                {place || (distanceMiles === null ? 'The listing gives no address.' : '')}
                {!home.zip ? (
                  <span className="trip__set">
                    {' '}
                    <LocationButton variant="field" />
                  </span>
                ) : null}
              </span>
            </div>
            {detail.ships || shipsNote || terms ? (
              <div className="trip__row">
                <TruckIcon size={18} className="trip__icon" />
                <span>
                  <strong>{detail.ships ? 'Ships' : 'Pickup'}</strong>
                  {shipsNote ? ` · ${shipsNote}` : ''}
                  {terms ? (
                    <details className="trip__terms">
                      <summary>Inspection and removal, from the listing</summary>
                      <p>{terms}</p>
                    </details>
                  ) : null}
                </span>
              </div>
            ) : null}
            {premiumPct !== null || premiumNote || termsUrl ? (
              <div className="trip__row">
                <PriceIcon size={18} className="trip__icon" />
                <span>
                  <strong>Fees</strong>
                  {premiumPct !== null ? ` · ${formatPercent(premiumPct)} buyer’s premium` : ''}
                  {premiumNote ? ` · ${premiumNote}` : ''}
                  {termsUrl ? (
                    <>
                      {' · '}
                      <a href={termsUrl} target="_blank" rel="noopener noreferrer">
                        Read the auction terms
                      </a>
                    </>
                  ) : null}
                </span>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="sale-contents" className="sale-contents">
            <h2 id="sale-contents" className="sale-contents__title">
              In this sale
            </h2>
            {description ? (
              <>
                <p className="sale-contents__text">{description}</p>
                <p className="sale-contents__source">From the listing on {sourceName}.</p>
              </>
            ) : (
              <p className="sale-contents__source">The listing gives no description. Open the sale to see its lots.</p>
            )}
          </section>

          <div className="lot-actions">
            {saleUrl ? (
              <a className="btn btn--primary btn--large" href={saleUrl} target="_blank" rel="noopener noreferrer">
                <span>Open the sale</span>
                <ExternalIcon size={16} strokeWidth={2.2} />
                <span className="visually-hidden"> on {sourceName} (opens in a new tab)</span>
              </a>
            ) : (
              <p className="muted small">The source did not publish a link for this sale.</p>
            )}
            {!user ? (
              <Link className="btn btn--outline btn--tall" to={`/signin?next=${encodeURIComponent(`/lot/${detail.id}`)}`}>
                Watch and remind me
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn--outline btn--tall"
                onClick={watchSale}
                disabled={saving || detail.closed || watching !== null}
              >
                {saving ? 'Saving…' : watching ? 'Watching this sale' : 'Watch and remind me'}
              </button>
            )}
            {watchMessage ? (
              <p className="form-note" role="status">
                {watchMessage} <Link to="/bids">Open Bids</Link>
              </p>
            ) : watching && !watchError ? (
              <p className="form-note">
                You are watching this sale. <Link to="/bids">Open Bids</Link>
              </p>
            ) : null}
            {watchError ? (
              <p className="field-error" role="alert">
                {watchError}
              </p>
            ) : null}
            <p className="muted small">Skeuos never bids for you. The button opens the sale on {sourceName}, where its lots are listed.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
