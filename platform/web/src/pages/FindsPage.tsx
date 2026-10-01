/**
 * Finds: buys ranked against a goal (0044). A goal says what the user is
 * shopping for (resale profit, personal use, or a project list), and every lot
 * it finds is priced by the strategy engine at today's bid: the invoice, the
 * trip, selling costs and the risk reserve, against an appraised value. The
 * appraisals come from the appraise-lots function; each one links to sold
 * listings so the estimate can be checked before a bid.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LotCard } from '../components/LotCard';
import { PlusIcon } from '../components/Icons';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import type { FinderGoalInsert, FinderGoalRow } from '../data/database.types';
import {
  appraiserStatus,
  createGoal,
  deleteGoal,
  fetchAppraisals,
  fetchFinderFacts,
  findCandidates,
  listGoals,
  requestAppraisals,
  updateGoal,
  APPRAISE_BATCH,
  type AppraiseResult,
  type StoredAppraisal,
} from '../data/finds';
import { fromSearchRow } from '../data/lotSummary';
import { fetchLotCloseInfo } from '../data/search';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import {
  evaluate,
  isSuggestion,
  MODE_LABELS,
  rank,
  soldListingsUrl,
  type Candidate,
  type FinderMode,
  type GoalSettings,
  type Suggestion,
} from '../lib/finder';
import { formatCentsShort, parseDollarsToCents, parsePercent } from '../lib/money';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';

const MODES: readonly FinderMode[] = ['resale', 'personal', 'project'];

const FOCUS_HINT: Readonly<Record<FinderMode, string>> = {
  resale: 'What you resell, e.g. “power tools, small engines”. Leave empty to scan everything near you.',
  personal: 'What you need, e.g. “riding mower” or “chest freezer”.',
  project: 'The project’s shopping list, one item per comma: “table saw, jointer, dust collector, clamps”.',
};

const CLOSING_CHOICES: readonly { readonly hours: number | null; readonly label: string }[] = [
  { hours: null, label: 'Any time' },
  { hours: 24, label: 'Within a day' },
  { hours: 72, label: 'Within 3 days' },
  { hours: 168, label: 'Within a week' },
  { hours: 336, label: 'Within 2 weeks' },
];

/** Suggestions shown before "more"; the rest fall short of the goal. */
const SHOWN = 40;

function settingsOf(goal: FinderGoalRow): GoalSettings {
  return {
    mode: goal.mode,
    focus: goal.focus,
    budgetCents: goal.budget_cents,
    minProfitCents: goal.min_profit_cents,
    minReturnPct: goal.min_return_pct === null ? null : Number(goal.min_return_pct),
    salesTaxPct: goal.sales_tax_pct === null ? null : Number(goal.sales_tax_pct),
    conservative: goal.conservative,
  };
}

function dollars(cents: number): string {
  return formatCentsShort(Math.round(cents / 100) * 100);
}

// ------------------------------------------------------------------ goal form

interface GoalFormProps {
  readonly initial: FinderGoalRow | null;
  readonly onSaved: (goal: FinderGoalRow) => void;
  readonly onCancel: (() => void) | null;
  readonly onDeleted: (() => void) | null;
}

function centsField(cents: number | null): string {
  return cents === null ? '' : String(cents / 100);
}

function GoalForm({ initial, onSaved, onCancel, onDeleted }: GoalFormProps) {
  const id = useId();
  const [mode, setMode] = useState<FinderMode>(initial?.mode ?? 'resale');
  const [name, setName] = useState(initial?.name ?? '');
  const [focus, setFocus] = useState(initial?.focus ?? '');
  const [budget, setBudget] = useState(centsField(initial?.budget_cents ?? null));
  const [minProfit, setMinProfit] = useState(centsField(initial?.min_profit_cents ?? 5000));
  const [minReturn, setMinReturn] = useState(initial?.min_return_pct === null || initial === null ? '' : String(initial.min_return_pct));
  const [radius, setRadius] = useState(initial?.radius_miles === null || initial === null ? '' : String(initial.radius_miles));
  const [closing, setClosing] = useState<number | null>(initial?.closing_within_hours ?? 168);
  const [ships, setShips] = useState(initial?.include_shippable ?? true);
  const [tax, setTax] = useState(initial?.sales_tax_pct === null || initial === null ? '' : String(initial.sales_tax_pct));
  const [conservative, setConservative] = useState(initial?.conservative ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const budgetCents = budget.trim() ? parseDollarsToCents(budget) : null;
    const minProfitCents = minProfit.trim() ? parseDollarsToCents(minProfit) : null;
    const minReturnPct = minReturn.trim() ? parsePercent(minReturn) : null;
    const salesTaxPct = tax.trim() ? parsePercent(tax) : null;
    const radiusMiles = radius.trim() ? Number(radius) : null;
    if (budget.trim() && (budgetCents === null || budgetCents === 0)) return setError('Budget: enter an amount, like 400.');
    if (minProfit.trim() && minProfitCents === null) return setError('Minimum profit: enter an amount, like 50.');
    if (minReturn.trim() && minReturnPct === null) return setError('Minimum return: enter a percent, like 30.');
    if (tax.trim() && (salesTaxPct === null || salesTaxPct > 20)) return setError('Sales tax: enter a percent from 0 to 20.');
    if (radiusMiles !== null && !(Number.isInteger(radiusMiles) && radiusMiles >= 1 && radiusMiles <= 1000)) {
      return setError('Distance: whole miles, 1 to 1000.');
    }
    const row: FinderGoalInsert = {
      name: name.trim() || MODE_LABELS[mode],
      mode,
      focus: focus.trim() || null,
      budget_cents: budgetCents,
      min_profit_cents: mode === 'resale' ? minProfitCents : null,
      min_return_pct: mode === 'resale' ? minReturnPct : null,
      radius_miles: radiusMiles,
      closing_within_hours: closing,
      include_shippable: ships,
      sales_tax_pct: salesTaxPct,
      conservative,
    };
    setSaving(true);
    setError(null);
    try {
      onSaved(initial ? await updateGoal(initial.id, row) : await createGoal(row));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That goal did not save.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!initial || !onDeleted) return;
    setSaving(true);
    try {
      await deleteGoal(initial.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That goal was not deleted.');
      setSaving(false);
    }
  }

  return (
    <form className="card goal-form" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="goal-form__title">
        {initial ? 'Edit goal' : 'What are you shopping for?'}
      </h2>
      <div className="segmented" role="tablist" aria-label="Goal">
        {MODES.map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className="segmented__tab" onClick={() => setMode(m)}>
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`${id}-focus`}>{mode === 'project' ? 'Shopping list' : 'Looking for'}</label>
        <textarea id={`${id}-focus`} className="input goal-form__focus" rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} />
        <span className="field__hint">{FOCUS_HINT[mode]}</span>
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="input" value={name} placeholder={MODE_LABELS[mode]} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-budget`}>Most per lot ($)</label>
          <input id={`${id}-budget`} className="input input--mono" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <span className="field__hint">The invoice, with premium and tax. Empty: no limit.</span>
        </div>
        {mode === 'resale' ? (
          <>
            <div className="field">
              <label htmlFor={`${id}-profit`}>Minimum profit ($)</label>
              <input id={`${id}-profit`} className="input input--mono" inputMode="decimal" value={minProfit} onChange={(e) => setMinProfit(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-return`}>Minimum return (%)</label>
              <input id={`${id}-return`} className="input input--mono" inputMode="decimal" value={minReturn} onChange={(e) => setMinReturn(e.target.value)} />
              <span className="field__hint">Profit as a share of what you pay. Empty: any.</span>
            </div>
          </>
        ) : null}
        <div className="field">
          <label htmlFor={`${id}-radius`}>Distance (mi)</label>
          <input id={`${id}-radius`} className="input input--mono" inputMode="numeric" value={radius} placeholder="Your usual" onChange={(e) => setRadius(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-closing`}>Closing</label>
          <select
            id={`${id}-closing`}
            className="input"
            value={closing === null ? '' : String(closing)}
            onChange={(e) => setClosing(e.target.value === '' ? null : Number(e.target.value))}
          >
            {CLOSING_CHOICES.map((c) => (
              <option key={c.label} value={c.hours === null ? '' : String(c.hours)}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-tax`}>Sales tax (%)</label>
          <input id={`${id}-tax`} className="input input--mono" inputMode="decimal" value={tax} placeholder="Default" onChange={(e) => setTax(e.target.value)} />
          <span className="field__hint">0 if you buy with a resale certificate.</span>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={ships} onChange={(e) => setShips(e.target.checked)} />
        <span>Include lots that ship</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={conservative} onChange={(e) => setConservative(e.target.checked)} />
        <span>Value lots at the low estimate</span>
      </label>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="goal-form__actions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save goal' : 'Find buys'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        ) : null}
        {initial && onDeleted ? (
          <button type="button" className="link-btn goal-form__delete" onClick={remove} disabled={saving}>
            Delete goal
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------- one find

function walkAwayText(s: Suggestion): string | null {
  const w = s.walkAway;
  if (w.status === 'ok' && w.maxBidCents !== null) {
    const keep = s.mode === 'resale' ? ' to keep your minimum profit' : ' to stay under what it is worth';
    return `Walk away above ${formatCentsShort(w.maxBidCents)}${keep}.`;
  }
  if (w.status === 'walk_away') return 'Already past the walk-away: let this one go.';
  return null;
}

function FindNumbers({ s, appraisal, title }: { s: Suggestion; appraisal: StoredAppraisal; title: string }) {
  const p = s.projection;
  const amount = p.profitCents ?? 0;
  const ret = p.returnOnCost === null ? null : Math.round(p.returnOnCost * 100);
  const headline =
    s.mode === 'resale'
      ? `${amount >= 0 ? 'Profit' : 'Loss'} about ${dollars(Math.abs(amount))}`
      : `${amount >= 0 ? 'Saves' : 'Costs'} about ${dollars(Math.abs(amount))}${amount >= 0 ? '' : ' more'} than buying it used`;
  const range =
    appraisal.lowCents !== null && appraisal.highCents !== null && appraisal.lowCents !== appraisal.highCents
      ? `${dollars(appraisal.lowCents)}–${dollars(appraisal.highCents)}`
      : dollars(s.valueCents);
  const walk = walkAwayText(s);
  const tags = [...s.fit.map((f) => `fits: ${f}`), ...appraisal.flags.map((f) => f.replace(/_/g, ' '))];
  return (
    <div className={`find${s.passes ? '' : ' find--short'}`}>
      <p className="find__headline">
        {headline}
        {s.mode === 'resale' && ret !== null ? <span className="find__return"> · {ret}% return</span> : null}
      </p>
      <p className="find__line">
        Won at {formatCentsShort(s.priceTodayCents)}: {p.allInCents === null ? 'cost unknown' : `${dollars(p.allInCents)} all-in`}
        {p.transportCents > 0 ? `, ${dollars(p.transportCents)} of it the trip` : ''}.
      </p>
      <p className="find__line">
        {s.mode === 'resale' ? 'Resells' : 'Sells used'} for {range}
        {s.valueBasis === 'low' ? ' (valued at the low end)' : ''} · <span className={`find__conf find__conf--${appraisal.confidence}`}>{appraisal.confidence} confidence</span>
        {appraisal.newPriceCents !== null ? ` · ${dollars(appraisal.newPriceCents)} new` : ''}
      </p>
      {walk ? <p className="find__line find__walk">{walk}</p> : null}
      {appraisal.rationale ? <p className="find__why">{appraisal.rationale}</p> : null}
      {s.shortfalls.length > 0 ? <p className="find__short">{s.shortfalls.join(' · ')}</p> : null}
      {tags.length > 0 ? (
        <ul className="find__tags" aria-label="Notes">
          {tags.map((t) => (
            <li key={t} className="chip chip--static">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="find__links">
        <a href={soldListingsUrl(appraisal.compsQuery ?? title)} target="_blank" rel="noopener noreferrer">
          Check sold prices
        </a>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- the page

export function FindsPage() {
  useDocumentTitle('Finds');
  const { user } = useAuth();
  const home = useHome();
  const now = useNow(60_000);
  const [params, setParams] = useSearchParams();
  const goals = useAsync(() => listGoals(), [user?.id], Boolean(user));
  const status = useAsync(() => appraiserStatus(), [user?.id], Boolean(user));
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [showShort, setShowShort] = useState(false);
  const [appraising, setAppraising] = useState(false);
  const [appraiseNote, setAppraiseNote] = useState<string | null>(null);

  const list = goals.data ?? [];
  const goal = list.find((g) => g.id === params.get('goal')) ?? list[0] ?? null;
  const choose = (g: FinderGoalRow) => setParams({ goal: g.id }, { replace: true });

  const results = useAsync(
    async () => {
      if (!goal) return null;
      const set = await findCandidates(goal, { zip: home.zip, radiusMiles: home.radiusMiles });
      const ids = set.rows.map((r) => r.lot_id);
      const [facts, appraisals, closeInfo] = await Promise.all([fetchFinderFacts(ids), fetchAppraisals(ids), fetchLotCloseInfo(ids)]);
      return { set, facts, appraisals, closeInfo };
    },
    [goal?.id, goal?.updated_at, home.zip, home.radiusMiles],
    Boolean(goal),
  );

  const ranked = useMemo(() => {
    const data = results.data;
    if (!goal || !data) return null;
    const settings = settingsOf(goal);
    const suggestions: Suggestion[] = [];
    const waiting: string[] = [];
    let noValue = 0;
    for (const row of data.set.rows) {
      const facts = data.facts.get(row.lot_id);
      if (!facts) continue;
      const stored = data.appraisals.get(row.lot_id) ?? null;
      // An appraisal of an older title no longer describes the lot: ask again.
      const appraisal = stored && stored.lotTitle === row.title ? stored : null;
      const candidate: Candidate = {
        lotId: row.lot_id,
        title: row.title,
        facts,
        distanceMiles: row.distance_miles === null ? null : Number(row.distance_miles),
        matched: data.set.matched.get(row.lot_id) ?? [],
      };
      const r = evaluate(candidate, settings, appraisal);
      if (isSuggestion(r)) suggestions.push(r);
      else if (r.why === 'unappraised') waiting.push(r.lotId);
      else noValue += 1;
    }
    return { suggestions: rank(suggestions), waiting, noValue };
  }, [goal, results.data]);

  async function appraiseNext() {
    if (!ranked) return;
    setAppraising(true);
    setAppraiseNote(null);
    try {
      const r: AppraiseResult = await requestAppraisals(ranked.waiting.slice(0, APPRAISE_BATCH));
      status.setData({ configured: r.configured, model: r.model, remaining: r.remaining, cap: r.cap });
      const skipped = Object.values(r.skipped).reduce((n, v) => n + v, 0);
      setAppraiseNote(
        [
          `${r.appraised} appraised`,
          r.failed > 0 ? `${r.failed} failed` : null,
          skipped > 0 ? `${skipped} skipped` : null,
          r.errors.length > 0 ? r.errors.join('; ') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      results.reload();
    } catch (err) {
      setAppraiseNote(err instanceof Error ? err.message : 'Appraisal did not run.');
    } finally {
      setAppraising(false);
    }
  }

  const byId = new Map((results.data?.set.rows ?? []).map((r) => [r.lot_id, r]));
  const passing = ranked?.suggestions.filter((s) => s.passes) ?? [];
  const short = ranked?.suggestions.filter((s) => !s.passes) ?? [];

  function card(s: Suggestion) {
    const row = byId.get(s.lotId);
    const appraisal = results.data?.appraisals.get(s.lotId);
    if (!row || !appraisal) return null;
    return (
      <li key={s.lotId}>
        <LotCard
          lot={fromSearchRow(row, results.data?.closeInfo.get(s.lotId))}
          now={now}
          from="/finds"
          layout="row"
          headingLevel={3}
          footer={<FindNumbers s={s} appraisal={appraisal} title={row.title} />}
        />
      </li>
    );
  }

  return (
    <div className="page finds">
      <header className="page-head">
        <h1 className="page-title">Finds</h1>
        {list.length > 0 && editing === null ? (
          <button type="button" className="btn btn--primary btn--pill" onClick={() => setEditing('new')}>
            <PlusIcon size={16} strokeWidth={2.4} />
            <span>New goal</span>
          </button>
        ) : null}
      </header>
      <p className="page-lead">Buys ranked by what they would make you, or save you, after every cost: premium, tax, the trip and selling fees.</p>

      {goals.loading && !goals.data ? (
        <LoadingState label="Loading your goals" />
      ) : goals.error ? (
        <ErrorState error={goals.error} onRetry={goals.reload} title="Your goals did not load" />
      ) : list.length === 0 || editing === 'new' ? (
        <GoalForm
          initial={null}
          onSaved={(g) => {
            setEditing(null);
            goals.reload();
            choose(g);
          }}
          onCancel={list.length > 0 ? () => setEditing(null) : null}
          onDeleted={null}
        />
      ) : (
        <>
          <div className="chip-row goal-chips" role="group" aria-label="Your goals">
            {list.map((g) => (
              <button key={g.id} type="button" className="chip" aria-pressed={goal?.id === g.id} onClick={() => choose(g)}>
                {g.name}
              </button>
            ))}
            {goal && editing === null ? (
              <button type="button" className="link-btn goal-chips__edit" onClick={() => setEditing('edit')}>
                Edit
              </button>
            ) : null}
          </div>
          {editing === 'edit' && goal ? (
            <GoalForm
              key={goal.id}
              initial={goal}
              onSaved={() => {
                setEditing(null);
                goals.reload();
              }}
              onCancel={() => setEditing(null)}
              onDeleted={() => {
                setEditing(null);
                setParams({}, { replace: true });
                goals.reload();
              }}
            />
          ) : null}
        </>
      )}

      {goal && editing === null ? (
        <>
          {!home.zip && !goal.postal_code ? (
            <p className="notice">Set your home ZIP in Profile so distances and pickup trips are counted.</p>
          ) : null}

          {results.loading && !results.data ? (
            <LoadingState label="Finding buys" />
          ) : results.error ? (
            <ErrorState error={results.error} onRetry={results.reload} title="Finds did not load" />
          ) : ranked ? (
            <>
              <p className="results-head finds__summary">
                {results.data?.set.rows.length ?? 0} lots checked · {passing.length} meet your goal
                {ranked.waiting.length > 0 ? ` · ${ranked.waiting.length} not appraised yet` : ''}
              </p>

              {ranked.waiting.length > 0 ? (
                status.data && !status.data.configured ? (
                  <p className="notice">
                    Appraisals are off. They start once an Anthropic API key is saved as the <code>ANTHROPIC_API_KEY</code> secret
                    for Supabase Edge Functions.
                  </p>
                ) : (
                  <div className="notice notice--pine finds__appraise">
                    <span>
                      {ranked.waiting.length} lots need a resale value before they can be ranked.
                      {status.data ? ` ${status.data.remaining} appraisals left today.` : ''}
                    </span>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={appraiseNext}
                      disabled={appraising || (status.data?.remaining ?? 1) === 0}
                    >
                      {appraising ? 'Appraising…' : `Appraise the next ${Math.min(APPRAISE_BATCH, ranked.waiting.length)}`}
                    </button>
                  </div>
                )
              ) : null}
              {appraiseNote ? <p className="field__hint finds__note">{appraiseNote}</p> : null}

              {passing.length > 0 ? (
                <ol className="finds__list" aria-label="Buys that meet your goal">
                  {passing.slice(0, SHOWN).map(card)}
                </ol>
              ) : (
                <EmptyState title={ranked.suggestions.length > 0 ? 'Nothing meets this goal yet' : 'Nothing ranked yet'}>
                  <p>
                    {ranked.waiting.length > 0
                      ? 'Appraise the lots above to rank them.'
                      : 'Widen the distance, raise the budget, or lower the minimum profit.'}
                  </p>
                </EmptyState>
              )}

              {short.length > 0 ? (
                <section className="finds__short" aria-label="Close, but short of your goal">
                  <button type="button" className="link-btn" aria-expanded={showShort} onClick={() => setShowShort((v) => !v)}>
                    {showShort ? 'Hide' : 'Show'} {short.length} that fall short
                  </button>
                  {showShort ? <ol className="finds__list">{short.slice(0, SHOWN).map(card)}</ol> : null}
                </section>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      <section aria-labelledby="finds-how" className="info-box">
        <h2 id="finds-how" className="info-box__title">
          How Finds works
        </h2>
        <p>
          Each lot gets a resale value from an AI appraisal of its listing: a range, a confidence and the reason. The numbers
          after that are the same walk-away calculator as every lot page. Estimates can be wrong, so check sold prices before
          you bid, and set your own walk-away on the lot.
        </p>
      </section>
    </div>
  );
}
