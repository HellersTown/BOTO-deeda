import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LotSummary } from '../data/lotSummary';
import { salePlace } from '../lib/sale';
import { ClosePill } from './ClosePill';
import { Photo } from './Photo';
import { DistanceTag, isWorthTheTrip, PriceTag, SaleTag, TierTag, WorthTheTrip } from './Tags';

/** What the lot page needs from the card that linked to it. */
export interface LotLinkState {
  readonly distanceMiles: number | null;
  /** The distance was measured to a city's centroid (0016), so it is approximate. */
  readonly distanceApprox?: boolean;
  readonly from: string;
}

/** "Milwaukee, WI · pickup": where, and how it gets home. The distance is shown beside it, as a tag. */
export function whereText(lot: Pick<LotSummary, 'city' | 'state' | 'ships' | 'matchBasis'>): string {
  const place = lot.city && lot.state ? `${lot.city}, ${lot.state}` : (lot.city ?? lot.state);
  const how = lot.ships ? (lot.matchBasis === 'ships_to_you' ? 'ships to you' : 'ships') : 'pickup';
  return [place, how].filter(Boolean).join(' · ');
}

/** The price as the card shows it: the current bid, else the opening bid; nothing is invented. */
function CardPrice({ lot }: { lot: Pick<LotSummary, 'currentBidCents' | 'nextBidCents'> }) {
  if (lot.currentBidCents !== null) return <PriceTag cents={lot.currentBidCents} />;
  if (lot.nextBidCents !== null) {
    return (
      <span className="lot-card__opens">
        <span className="lot-card__opens-label">Opens at</span> <PriceTag cents={lot.nextBidCents} />
      </span>
    );
  }
  return <span className="lot-card__no-price">No price listed</span>;
}

interface CardProps {
  lot: LotSummary;
  now: Date;
  from: string;
  layout?: 'auto' | 'row';
  headingLevel?: 2 | 3;
  footer?: ReactNode;
}

export function LotCard(props: CardProps) {
  if (props.lot.saleLevel) return <SaleCard {...props} />;
  const { lot, now, from, layout = 'auto', headingLevel = 2, footer } = props;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const state: LotLinkState = { distanceMiles: lot.distanceMiles, distanceApprox: lot.distanceApprox, from };
  const worth = isWorthTheTrip(lot.sleeperScore);
  return (
    <article className={`lot-card lot-card--${layout}${lot.closed ? ' lot-card--closed' : ''}`}>
      <Link to={`/lot/${lot.id}`} state={state} className="lot-card__link">
        <Photo src={lot.imageUrl} alt="" className="lot-card__photo" />
        <div className="lot-card__body">
          <div className="lot-card__meta">
            <TierTag tier={lot.sourceTier} />
            {lot.sourceName ? <span className="lot-card__source">{lot.sourceName}</span> : null}
            {worth ? <WorthTheTrip className="lot-card__worth lot-card__worth--meta" /> : null}
          </div>
          <Heading className="lot-card__title">{lot.title}</Heading>
          <p className="lot-card__where">
            {lot.distanceMiles !== null ? (
              <>
                <DistanceTag miles={lot.distanceMiles} approximate={lot.distanceApprox} />
                <span aria-hidden="true"> · </span>
              </>
            ) : null}
            <span>{whereText(lot)}</span>
          </p>
          <div className="lot-card__foot">
            <CardPrice lot={lot} />
            {worth ? <WorthTheTrip className="lot-card__worth lot-card__worth--foot" /> : null}
            <span className="lot-card__close">
              <ClosePill closesAt={lot.closesAt} precision={lot.closePrecision} timeZone={lot.timeZone} closed={lot.closed} now={now} />
            </span>
          </div>
        </div>
      </Link>
      {footer ? <div className="lot-card__actions">{footer}</div> : null}
    </article>
  );
}

/**
 * A sale-level row (0023): a whole sale from a source that lists sales, not
 * lots. The same card as a lot's, and the whole of it opens the lot page, but
 * where a lot has its price it has "Sale · 421 lots", its close is stated as a
 * time of day in the viewer's zone, and it names who runs the sale. It has no
 * price, bid count or sleeper score, so none is shown.
 */
function SaleCard({ lot, now, from, layout = 'auto', headingLevel = 2, footer }: CardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const state: LotLinkState = { distanceMiles: lot.distanceMiles, distanceApprox: lot.distanceApprox, from };
  const seller = lot.auctioneer ?? lot.sourceName;
  const place = salePlace(lot.city, lot.state);
  return (
    <article className={`lot-card lot-card--sale lot-card--${layout}${lot.closed ? ' lot-card--closed' : ''}`}>
      <Link to={`/lot/${lot.id}`} state={state} className="lot-card__link">
        <Photo src={lot.imageUrl} alt="" className="lot-card__photo" />
        <div className="lot-card__body">
          <div className="lot-card__meta">
            <TierTag tier={lot.sourceTier} />
            {seller ? <span className="lot-card__source">{seller}</span> : null}
          </div>
          <Heading className="lot-card__title">{lot.title}</Heading>
          {lot.distanceMiles !== null || place ? (
            <p className="lot-card__where">
              {lot.distanceMiles !== null ? <DistanceTag miles={lot.distanceMiles} approximate={lot.distanceApprox} /> : null}
              {lot.distanceMiles !== null && place ? <span aria-hidden="true"> · </span> : null}
              {place ? <span>{place}</span> : null}
            </p>
          ) : null}
          <div className="lot-card__foot">
            <SaleTag lotCount={lot.saleLotCount} />
            <span className="lot-card__close">
              <ClosePill closesAt={lot.closesAt} precision={lot.closePrecision} timeZone={lot.timeZone} closed={lot.closed} now={now} clock />
            </span>
          </div>
        </div>
      </Link>
      {footer ? <div className="lot-card__actions">{footer}</div> : null}
    </article>
  );
}
