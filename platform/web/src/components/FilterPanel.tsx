import { useEffect, useId, useState } from 'react';
import { formatCentsShort, parseDollarsToCents } from '../lib/money';
import {
  isSellerChecked,
  RADIUS_CHOICES,
  toggleSeller,
  ungroupedTiers,
  type RadiusChoice,
  type SearchFilters,
} from '../lib/searchParams';
import { SELLER_GROUPS, TIER_LABEL } from '../lib/tiers';

function PriceInput({
  label,
  cents,
  placeholder,
  onCommit,
}: {
  label: string;
  cents: number | null;
  placeholder: string;
  onCommit: (cents: number | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(cents === null ? '' : formatCentsShort(cents));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(cents === null ? '' : formatCentsShort(cents));
    setInvalid(false);
  }, [cents]);

  function commit() {
    if (text.trim() === '') {
      setInvalid(false);
      if (cents !== null) onCommit(null);
      return;
    }
    const parsed = parseDollarsToCents(text);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== cents) onCommit(parsed);
  }

  return (
    <div className="field">
      <label htmlFor={id} className="field__label--small">
        {label}
      </label>
      <input
        id={id}
        className="input input--compact input--mono"
        inputMode="decimal"
        placeholder={placeholder}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {invalid ? <span className="field-error">Enter a dollar amount</span> : null}
    </div>
  );
}

/** How far, who is selling and price: the design's desktop sidebar (also the mobile filter sheet). */
export function FilterPanel({
  filters,
  onChange,
  zip,
}: {
  filters: SearchFilters;
  onChange: (next: SearchFilters) => void;
  zip: string | null;
}) {
  const name = useId();
  const radii: RadiusChoice[] = [...RADIUS_CHOICES];
  if (typeof filters.radius === 'number' && !radii.includes(filters.radius)) radii.push(filters.radius);
  radii.sort((a, b) => (a as number) - (b as number));
  radii.push('anywhere');
  const extra = ungroupedTiers(filters.tiers);
  const noneChecked = filters.tiers !== null && filters.tiers.length === 0;
  const someUnchecked = filters.tiers !== null;

  return (
    <div className="filters">
      <fieldset className="filters__group">
        <legend className="filters__legend">How far you will travel</legend>
        <p className="filters__hint filters__hint--lead">{zip ? `From ${zip}` : 'Set your ZIP to limit by distance.'}</p>
        {radii.map((r) => (
          <label key={String(r)} className="check">
            <input
              type="radio"
              name={`${name}-dist`}
              checked={filters.radius === r}
              disabled={!zip && r !== 'anywhere'}
              onChange={() => onChange({ ...filters, radius: r })}
            />
            {r === 'anywhere' ? 'Anywhere' : `${r} mi`}
          </label>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={filters.includeShippable}
            onChange={(e) => onChange({ ...filters, includeShippable: e.target.checked })}
          />
          Include lots that ship
        </label>
      </fieldset>

      <fieldset className="filters__group">
        <legend className="filters__legend">Who is selling</legend>
        {SELLER_GROUPS.map((g) => (
          <label key={g.key} className="check">
            <input
              type="checkbox"
              checked={isSellerChecked(filters.tiers, g.key)}
              onChange={() => onChange({ ...filters, tiers: toggleSeller(filters.tiers, g.key) })}
            />
            {g.label}
          </label>
        ))}
        {noneChecked ? <p className="filters__hint">Check at least one seller type to search.</p> : null}
        {extra.length > 0 ? (
          <p className="filters__hint">Also from your search: {extra.map((t) => TIER_LABEL[t]).join(', ')}.</p>
        ) : someUnchecked && !noneChecked ? (
          <p className="filters__hint">Dealers, wholesale and marketplace sellers show only when every type is checked.</p>
        ) : null}
      </fieldset>

      <fieldset className="filters__group filters__group--price">
        <legend className="filters__legend">Price</legend>
        <PriceInput label="Min" cents={filters.minCents} placeholder="$0" onCommit={(c) => onChange({ ...filters, minCents: c })} />
        <PriceInput label="Max" cents={filters.maxCents} placeholder="Any" onCommit={(c) => onChange({ ...filters, maxCents: c })} />
        <p className="filters__hint filters__hint--wide">Max is checked against the next bid you would have to place.</p>
      </fieldset>
    </div>
  );
}
