import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LotSummary } from '../data/lotSummary';
import { formatMiles } from '../lib/distance';
import { formatCents } from '../lib/money';
import { ClosePill } from './ClosePill';
import { Photo } from './Photo';
import { TierBadge } from './TierBadge';

/**
 * Show "Treasure in plain sight" from this sleeper score (0-10, compute_sleeper
 * in 0006). A design threshold: a thin description, little bidding and enough
 * photos to judge it together reach about 6.
 */
export const TREASURE_MIN_SCORE = 5;

/** What the lot page needs from the card that linked to it. */
export interface LotLinkState {
  readonly distanceMiles: number | null;
  readonly from: string;
}

export function priceText(lot: Pick<LotSummary, 'currentBidCents' | 'nextBidCents'>): string {
  if (lot.currentBidCents !== null) return formatCents(lot.currentBidCents);
  if (lot.nextBidCents !== null) return `Opens at ${formatCents(lot.nextBidCents)}`;
  return 'No price listed';
}

export function whereText(lot: Pick<LotSummary, 'city' | 'state' | 'distanceMiles' | 'ships' | 'matchBasis'>): string {
  const place = lot.city && lot.state ? `${lot.city}, ${lot.state}` : (lot.city ?? lot.state);
  const how = lot.ships ? (lot.matchBasis === 'ships_to_you' ? 'ships to you' : 'ships') : 'pickup';
  return [place, lot.distanceMiles !== null ? formatMiles(lot.distanceMiles) : null, how].filter(Boolean).join(' · ');
}

export function LotCard({
  lot,
  now,
  from,
  layout = 'auto',
  headingLevel = 2,
  footer,
}: {
  lot: LotSummary;
  now: Date;
  from: string;
  layout?: 'auto' | 'row';
  headingLevel?: 2 | 3;
  footer?: ReactNode;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const state: LotLinkState = { distanceMiles: lot.distanceMiles, from };
  const treasure = lot.sleeperScore !== null && lot.sleeperScore >= TREASURE_MIN_SCORE;
  return (
    <article className={`lot-card lot-card--${layout}${lot.closed ? ' lot-card--closed' : ''}`}>
      <Link to={`/lot/${lot.id}`} state={state} className="lot-card__link">
        <Photo src={lot.imageUrl} alt="" className="lot-card__photo" />
        <div className="lot-card__body">
          <div className="lot-card__meta">
            <TierBadge tier={lot.sourceTier} />
            {lot.sourceName ? <span className="lot-card__source">{lot.sourceName}</span> : null}
          </div>
          <Heading className="lot-card__title">{lot.title}</Heading>
          <p className="lot-card__where">{whereText(lot)}</p>
          {treasure ? <p className="treasure">Treasure in plain sight</p> : null}
          <div className="lot-card__foot">
            <span className="lot-card__price">{priceText(lot)}</span>
            <ClosePill closesAt={lot.closesAt} precision={lot.closePrecision} timeZone={lot.timeZone} closed={lot.closed} now={now} />
          </div>
        </div>
      </Link>
      {footer ? <div className="lot-card__actions">{footer}</div> : null}
    </article>
  );
}
