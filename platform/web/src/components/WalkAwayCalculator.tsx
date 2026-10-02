import { SPEC, type ParamUse, type Recommendation } from '@platform/strategy';
import { useId } from 'react';
import { distanceWords } from '../lib/distance';
import { formatCents, formatPercent } from '../lib/money';

const UNVERIFIED = new Set(['PLACEHOLDER', 'UNVERIFIED']);

/** True when any named parameter behind a number is a PLACEHOLDER or UNVERIFIED value. */
function unverified(params: readonly ParamUse[], names: readonly string[]): boolean {
  return params.some((p) => names.includes(p.name) && UNVERIFIED.has(p.status));
}

/** Whether a spec constant (docs/06 section 9.2) is itself unverified research, per its status note. */
function constantUnverified(name: keyof typeof SPEC.constants_meta): boolean {
  return /^(UNVERIFIED|PLACEHOLDER)/.test(SPEC.constants_meta[name].status);
}

/** The pickup trip is 2 x miles x cost-per-mile + time; both constants carry their own status. */
const PICKUP_UNVERIFIED = constantUnverified('mileage_cost_cents_per_mile') || constantUnverified('pickup_time_cost_cents');

function Tag({ show, label = 'unverified' }: { show: boolean; label?: string }) {
  return show ? <span className="tag tag--unverified">{label}</span> : null;
}

function premiumSource(p: ParamUse | undefined): string | null {
  if (!p) return null;
  if (p.status === 'LOT') return 'from the terms';
  if (p.source.startsWith('platform default')) return 'site default';
  return null;
}

/**
 * "Count the cost" (Lot.dc.html): the walk-away number for someone who will
 * keep the thing. It runs the strategy engine's personal-use arm (userGoal
 * 'use', docs/06 S2): "Worth to you" is the fixed-price alternative, the
 * cushion is the margin kept below it, and resale costs do not apply. The
 * caller builds `rec` with those inputs (see LotPage).
 */
export function WalkAwayCalculator({
  rec,
  worthText,
  onWorthText,
  cushionText,
  onCushionText,
  distanceMiles,
  distanceApprox,
  homeZip,
}: {
  rec: Recommendation;
  worthText: string;
  onWorthText: (v: string) => void;
  cushionText: string;
  onCushionText: (v: string) => void;
  distanceMiles: number | null;
  distanceApprox: boolean;
  homeZip: string | null;
}) {
  const worthId = useId();
  const cushionId = useId();
  const w = rec.walkAway;
  const b = w.breakdown;
  const params = w.parameters;
  const byName = (name: string) => params.find((p) => p.name === name);
  const hasValue = b.expectedResaleCents !== null;
  const worthInvalid = worthText.trim() !== '' && !hasValue;

  const tripLabel =
    b.transportBasis === 'shipping'
      ? 'Shipping to you'
      : `The trip${distanceMiles !== null ? `, ${distanceWords(distanceMiles, distanceApprox)}` : ''}`;
  const tripValue =
    b.transportBasis === 'none'
      ? distanceMiles === null && homeZip === null
        ? 'Set your ZIP'
        : 'Not included'
      : `${hasValue ? '−' : ''}${formatCents(b.transportCents)}`;

  let result: { big: string; note: string | null; tone: 'accent' | 'muted' | 'stop' };
  if (w.status === 'insufficient_data') {
    result = { big: 'Add its worth', note: 'Enter what it is worth to you to get your number.', tone: 'muted' };
  } else if (w.status === 'invalid_input') {
    result = { big: 'Not available', note: w.reason, tone: 'muted' };
  } else if (w.hammerCeilingCents === 0) {
    result = { big: formatCents(0), note: w.reason, tone: 'stop' };
  } else if (w.status === 'walk_away') {
    result = { big: formatCents(w.hammerCeilingCents ?? 0), note: w.reason, tone: 'stop' };
  } else {
    result = { big: formatCents(w.hammerCeilingCents ?? 0), note: null, tone: 'accent' };
  }

  return (
    <section className="calc" aria-labelledby="cost">
      <h2 id="cost" className="calc__title">
        Count the cost
      </h2>
      <p className="calc__intro">Set your walk-away before you bid, from what it is worth to you. Then bid it once.</p>
      <div className="field-grid">
        <div className="field">
          <label htmlFor={worthId}>Worth to you</label>
          <input
            id={worthId}
            className="input input--mono"
            inputMode="decimal"
            placeholder="$"
            value={worthText}
            onChange={(e) => onWorthText(e.target.value)}
            aria-invalid={worthInvalid || undefined}
            aria-describedby={`${worthId}-hint`}
          />
          <span id={`${worthId}-hint`} className={worthInvalid ? 'field-error' : 'field__hint'}>
            {worthInvalid ? 'Enter a dollar amount' : 'What the same thing costs new or from a dealer'}
          </span>
        </div>
        <div className="field">
          <label htmlFor={cushionId}>Cushion you keep</label>
          <input
            id={cushionId}
            className="input input--mono"
            inputMode="decimal"
            placeholder="0%"
            value={cushionText}
            onChange={(e) => onCushionText(e.target.value)}
            aria-describedby={`${cushionId}-hint`}
          />
          <span id={`${cushionId}-hint`} className="field__hint">
            Percent kept below its worth
          </span>
        </div>
      </div>

      <dl className="calc__rows">
        {hasValue ? (
          <>
            <dt>Worth to you</dt>
            <dd>{formatCents(b.expectedResaleCents ?? 0)}</dd>
            {(b.profitTargetCents ?? 0) > 0 ? (
              <>
                <dt>Cushion you keep</dt>
                <dd>−{formatCents(b.profitTargetCents ?? 0)}</dd>
              </>
            ) : null}
          </>
        ) : null}
        <dt>
          Buyer’s premium <Tag show={unverified(params, ['buyer_premium_pct'])} />
          {premiumSource(byName('buyer_premium_pct')) ? (
            <span className="calc__source"> {premiumSource(byName('buyer_premium_pct'))}</span>
          ) : null}
        </dt>
        <dd>{formatPercent(w.rates.buyerPremiumPct)}</dd>
        <dt>
          Sales tax, card fee <Tag show={unverified(params, ['card_fee_rate', 'sales_tax_rate'])} />
        </dt>
        <dd>
          {formatPercent(w.rates.salesTaxPct)} · {formatPercent(w.rates.cardFeePct)}
        </dd>
        <dt>
          {tripLabel} <Tag show={b.transportBasis === 'distance' && PICKUP_UNVERIFIED} />
        </dt>
        <dd>{tripValue}</dd>
        {hasValue ? (
          <>
            <dt>
              Repairs <Tag show={unverified(params, ['category.repair_reserve_rate'])} />
            </dt>
            <dd>−{formatCents(b.repairReserveCents ?? 0)}</dd>
            <dt>
              Risk reserve <Tag show={unverified(params, ['category.uncertainty_haircut_rate'])} />
            </dt>
            <dd>−{formatCents(b.uncertaintyReserveCents ?? 0)}</dd>
          </>
        ) : (
          <>
            <dt>Repairs</dt>
            <dd className="calc__pending">After you add its worth</dd>
          </>
        )}
      </dl>

      <div className={`calc__result calc__result--${result.tone}`}>
        <span className="calc__result-label">Walk away above</span>
        <span className="calc__result-value">{result.big}</span>
      </div>
      {result.note ? <p className="calc__note">{result.note}</p> : null}
      {w.status === 'ok' && w.maxBidCents !== null ? (
        <p className="calc__typein">
          What to type in: <strong>{formatCents(w.maxBidCents)}</strong>
          {w.maxBidCents !== w.hammerCeilingCents ? ', your number rounded down to a bid the site accepts' : ''}.
          {w.allInAtMaxBidCents !== null ? ` Winning there costs about ${formatCents(w.allInAtMaxBidCents)} all-in.` : ''}
        </p>
      ) : null}
      {w.warnings.length > 0 ? (
        <ul className="calc__warnings">
          {w.warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <p className="calc__foot">If the price passes it, let it go. Another will come.</p>
      <p className="calc__fine">Values the research could not verify are marked “unverified” wherever they are used.</p>
    </section>
  );
}
