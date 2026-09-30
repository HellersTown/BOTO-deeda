import { SPEC, type ParamUse, type Recommendation } from '@platform/strategy';
import { useId } from 'react';
import { formatMiles } from '../lib/distance';
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

export function WalkAwayCalculator({
  rec,
  resaleText,
  onResaleText,
  marginText,
  onMarginText,
  distanceMiles,
  homeZip,
}: {
  rec: Recommendation;
  resaleText: string;
  onResaleText: (v: string) => void;
  marginText: string;
  onMarginText: (v: string) => void;
  distanceMiles: number | null;
  homeZip: string | null;
}) {
  const resaleId = useId();
  const marginId = useId();
  const w = rec.walkAway;
  const b = w.breakdown;
  const params = w.parameters;
  const byName = (name: string) => params.find((p) => p.name === name);
  const hasValue = b.expectedResaleCents !== null;
  const categoryKey = rec.rules.categoryKey ?? 'other';
  const defaultMargin = SPEC.categories[categoryKey]?.target_margin_rate;
  const resaleInvalid = resaleText.trim() !== '' && !hasValue;

  const transportLabel =
    b.transportBasis === 'distance'
      ? `Pickup${distanceMiles !== null ? `, ${formatMiles(distanceMiles)}` : ''}`
      : b.transportBasis === 'shipping'
        ? 'Shipping to you'
        : 'Pickup';
  const transportValue =
    b.transportBasis === 'none'
      ? distanceMiles === null && homeZip === null
        ? 'Set your ZIP'
        : 'Not included'
      : formatCents(b.transportCents);

  let result: { big: string; note: string | null; tone: 'accent' | 'muted' | 'stop' };
  if (w.status === 'insufficient_data') {
    result = { big: 'Add a price', note: 'Enter what it sells for to get your number.', tone: 'muted' };
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
    <section className="calc" aria-labelledby="walkaway">
      <h2 id="walkaway" className="calc__title">
        Your walk-away number
      </h2>
      <p className="calc__intro">
        Decide it now, from what the item sells for, then bid it once. Never raise it because other people are bidding.
      </p>
      <div className="field-grid">
        <div className="field">
          <label htmlFor={resaleId}>It sells for</label>
          <input
            id={resaleId}
            className="input"
            inputMode="decimal"
            placeholder="$ recent sold price"
            value={resaleText}
            onChange={(e) => onResaleText(e.target.value)}
            aria-invalid={resaleInvalid || undefined}
            aria-describedby={`${resaleId}-hint`}
          />
          <span id={`${resaleId}-hint`} className="field__hint">
            {resaleInvalid ? 'Enter a dollar amount' : 'Median of recent sold prices, same condition'}
          </span>
        </div>
        <div className="field">
          <label htmlFor={marginId}>Profit you want</label>
          <input
            id={marginId}
            className="input"
            inputMode="decimal"
            placeholder={defaultMargin !== undefined ? `${formatPercent(defaultMargin * 100)} default` : '%'}
            value={marginText}
            onChange={(e) => onMarginText(e.target.value)}
            aria-describedby={`${marginId}-hint`}
          />
          <span id={`${marginId}-hint`} className="field__hint">
            {marginText.trim() === '' ? 'Category default, unverified' : 'Percent of the sale price'}
          </span>
        </div>
      </div>

      <dl className="calc__rows">
        {hasValue ? (
          <>
            <dt>It sells for</dt>
            <dd>{formatCents(b.expectedResaleCents ?? 0)}</dd>
            <dt>
              Selling fees <Tag show={unverified(params, ['category.sell_fee_rate'])} />
            </dt>
            <dd>−{formatCents(b.sellFeesCents ?? 0)}</dd>
            <dt>
              Shipping to your buyer <Tag show={unverified(params, ['category.outbound_ship_cents'])} />
            </dt>
            <dd>−{formatCents(b.outboundShipCents ?? 0)}</dd>
            <dt>
              Profit you want{' '}
              <Tag show={unverified(params, ['category.target_margin_rate', 'category.min_profit_cents'])} />
            </dt>
            <dd>−{formatCents(b.profitTargetCents ?? 0)}</dd>
            <dt>
              Risk reserve <Tag show={unverified(params, ['category.uncertainty_haircut_rate'])} />
            </dt>
            <dd>−{formatCents(b.uncertaintyReserveCents ?? 0)}</dd>
            <dt>
              Repairs <Tag show={unverified(params, ['category.repair_reserve_rate'])} />
            </dt>
            <dd>−{formatCents(b.repairReserveCents ?? 0)}</dd>
          </>
        ) : null}
        <dt>
          {transportLabel}{' '}
          <Tag show={b.transportBasis === 'distance' && PICKUP_UNVERIFIED} />
        </dt>
        <dd>{b.transportBasis === 'none' ? transportValue : `${hasValue ? '−' : ''}${transportValue}`}</dd>
        <dt>
          Buyer’s premium <Tag show={unverified(params, ['buyer_premium_pct'])} />
          {premiumSource(byName('buyer_premium_pct')) ? (
            <span className="calc__source"> {premiumSource(byName('buyer_premium_pct'))}</span>
          ) : null}
        </dt>
        <dd>{formatPercent(w.rates.buyerPremiumPct)}</dd>
        <dt>
          Card fee, tax <Tag show={unverified(params, ['card_fee_rate', 'sales_tax_rate'])} />
        </dt>
        <dd>
          {formatPercent(w.rates.cardFeePct)} · {formatPercent(w.rates.salesTaxPct)}
        </dd>
        {!hasValue ? (
          <>
            <dt>Repairs</dt>
            <dd className="muted">After you add a price</dd>
          </>
        ) : null}
      </dl>

      <div className={`calc__result calc__result--${result.tone}`}>
        <span className="calc__result-label">Bid at most</span>
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
      <p className="calc__foot">Values the research could not verify are marked “unverified” wherever they are used.</p>
    </section>
  );
}
