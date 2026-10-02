import { parseQuery } from '@platform/query';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CameraIcon, CloseIcon } from '../components/Icons';
import { UpgradePrompt } from '../components/UpgradePrompt';
import { DataError, describeError } from '../data/errors';
import { createHunt, runMyHunt } from '../data/hunts';
import { getMyEntitlements, listTierLimits } from '../data/profile';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { latencyWords } from '../lib/dates';
import {
  chipsFor,
  deriveHuntName,
  draftFromParse,
  huntHasCriteria,
  removeChip,
  setDraftRadius,
  toHuntInsert,
  type HuntDraft,
} from '../lib/huntDraft';
import { nextPlan, planName } from '../lib/plans';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';

const HUNT_RADII: readonly number[] = [10, 25, 60, 100, 200, 500];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function NewHuntPage() {
  useDocumentTitle('New hunt');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const home = useHome();
  const describeId = useId();
  const nameId = useId();
  const radiusId = useId();

  const [text, setText] = useState(params.get('q') ?? '');
  const settled = useDebounced(text, 250);
  const parse = useMemo(
    () => parseQuery(settled, { homePostalCode: home.zip ?? undefined, defaultRadiusMiles: home.radiusMiles }),
    [settled, home.zip, home.radiusMiles],
  );

  // Chip removals apply to the current reading; new words start a fresh reading.
  const [draft, setDraft] = useState<HuntDraft>(() => draftFromParse(parse));
  const [draftFor, setDraftFor] = useState(parse);
  let current = draft;
  if (draftFor !== parse) {
    current = draftFromParse(parse);
    setDraft(current);
    setDraftFor(parse);
  }

  const placeName = current.fields.postal_code && current.fields.postal_code === home.zip ? (home.place?.city ?? null) : null;
  const suggested = deriveHuntName(current, placeName);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const shownName = nameTouched ? name : suggested;
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);

  const ent = useAsync(() => getMyEntitlements(), [user?.id], Boolean(user));
  const tiers = useAsync(() => listTierLimits(), []);
  const chips = chipsFor(current);
  const f = current.fields;
  const canSave = huntHasCriteria(current) && shownName.trim() !== '' && !saving;
  const atLimit =
    ent.data?.max_active_hunts !== null && ent.data?.max_active_hunts !== undefined && (ent.data.hunts_active ?? 0) >= ent.data.max_active_hunts;
  const tier = ent.data?.tier ?? 'free';
  const upTier = nextPlan(tier);
  const up = upTier ? tiers.data?.find((t) => t.tier === upTier) : undefined;
  const plan = planName(tier);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!user || !canSave) return;
    setSaving(true);
    setError(null);
    setLimitMessage(null);
    try {
      const hunt = await createHunt(toHuntInsert(current, { userId: user.id, name: shownName, notifyImmediately: notify }));
      let firstRun: string | null = null;
      try {
        await runMyHunt(hunt.id);
      } catch (err) {
        console.warn(err);
        firstRun = 'The hunt is saved. Its first check did not finish; the scheduled run will fill in matches shortly.';
      }
      navigate(`/hunts/${hunt.id}`, { state: { created: true, note: firstRun } });
    } catch (err) {
      if (err instanceof DataError && err.kind === 'hunt_limit') setLimitMessage(err.detail);
      else setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const locationChip = f.postal_code ? (
    <span className="chip chip--static">
      <span className="chip__label">Within</span>
      <label htmlFor={radiusId} className="visually-hidden">
        Change distance
      </label>
      <select
        id={radiusId}
        className="chip__select"
        value={f.radius_miles ?? 60}
        onChange={(e) => setDraft(setDraftRadius(current, Number(e.target.value)))}
      >
        {[...new Set([...HUNT_RADII, f.radius_miles ?? 60])].sort((a, b) => a - b).map((r) => (
          <option key={r} value={r}>
            {r} mi
          </option>
        ))}
      </select>
      <span>of {f.postal_code}</span>
    </span>
  ) : f.states.length === 0 ? (
    <span className="chip chip--static">
      <span className="chip__label">Where</span> {home.zip ? `near your home ZIP ${home.zip}` : 'anywhere (no ZIP set)'}
    </span>
  ) : null;

  return (
    <div className="page page--narrow">
      <header className="page-head">
        <h1 className="page-title">New hunt</h1>
        <Link to="/hunts" className="icon-btn" aria-label="Close">
          <CloseIcon />
        </Link>
      </header>

      <form className="stack" onSubmit={save}>
        <div className="field">
          <label htmlFor={describeId} className="field__label--strong">
            What do you need? Say it the way you would tell a friend.
          </label>
          <textarea
            id={describeId}
            className="input input--strong textarea"
            rows={3}
            value={text}
            placeholder="Pressure canner, All American or Presto, under $150 within 60 miles"
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <section aria-labelledby="readas" className="card read-panel">
          <h2 id="readas" className="read-panel__title">
            Read as
          </h2>
          {settled.trim() === '' ? (
            <p className="muted small">Type what you are looking for and the reading appears here.</p>
          ) : (
            <>
              <div className="chip-wrap">
                {chips.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="chip chip--removable"
                    aria-label={c.removeLabel}
                    onClick={() => setDraft(removeChip(current, c.id))}
                  >
                    <span className="chip__label">{c.label}</span> {c.value} <span aria-hidden="true">×</span>
                  </button>
                ))}
                {locationChip}
              </div>
              <p className="muted small">
                {f.include_shippable ? 'Lots that ship are included.' : 'Lots that only ship from elsewhere are left out.'}
              </p>
              <ul className="read-panel__notes">
                {current.parse.explanation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {current.removed.length ? (
                <p className="muted small">You removed: {current.removed.join('; ')}.</p>
              ) : null}
              {!huntHasCriteria(current) ? (
                <p className="field-error">Add at least one word or brand to look for.</p>
              ) : null}
            </>
          )}
        </section>

        <button type="button" className="photo-slot" disabled aria-describedby="photo-note">
          <CameraIcon size={24} />
          <span className="photo-slot__text">
            <span className="photo-slot__title">Add a photo</span>
            <span id="photo-note" className="small muted">
              {planName('pro')}: also match lots that look like it. Coming soon.
            </span>
          </span>
        </button>

        <div className="field">
          <label htmlFor={nameId} className="field__label--strong">
            Name
          </label>
          <input
            id={nameId}
            className="input"
            value={shownName}
            maxLength={120}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
          />
        </div>

        <label className="toggle-row">
          <span className="toggle-row__text">
            <span className="toggle-row__title">Tell me when one is listed</span>
            <span className="small muted">
              {plan}: {latencyWords(ent.data?.alert_latency_seconds)}.
              {up && upTier ? ` ${planName(upTier)}: ${latencyWords(up.alert_latency_seconds)}.` : ''}
            </span>
          </span>
          <input type="checkbox" className="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        </label>

        {limitMessage !== null ? <UpgradePrompt ent={ent.data} message={limitMessage} onDismiss={() => setLimitMessage(null)} /> : null}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="form-foot">
          {ent.data && ent.data.max_active_hunts !== null ? (
            <p className="muted small center">
              {atLimit
                ? `All ${ent.data.max_active_hunts} hunts on ${plan} are in use. Pause one to start this.`
                : `This will be hunt ${(ent.data.hunts_active ?? 0) + 1} of ${ent.data.max_active_hunts} on ${plan}.`}
            </p>
          ) : null}
          <button type="submit" className="btn btn--primary btn--large btn--block" disabled={!canSave}>
            {saving ? 'Starting…' : 'Start watching'}
          </button>
        </div>
      </form>
    </div>
  );
}
