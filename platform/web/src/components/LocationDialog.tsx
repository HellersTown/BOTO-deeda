import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { describeError } from '../data/errors';
import { lookupPostalCode, normalizeZip } from '../data/postal';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';
import { CloseIcon, PinIcon } from './Icons';

export const RADIUS_OPTIONS: readonly number[] = [25, 50, 100, 200];

/** "Where you bid from": ZIP and radius, checked against the postal_codes gazetteer before saving. */
export function LocationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const home = useHome();
  const { user } = useAuth();
  const zipId = useId();
  const radiusId = useId();
  const errorId = useId();
  const [zip, setZip] = useState(home.zip ?? '');
  const [radius, setRadius] = useState(home.radiusMiles);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setZip(home.zip ?? '');
      setRadius(home.radiusMiles);
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, home.zip, home.radiusMiles]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeZip(zip);
    if (!normalized) {
      setError('Enter a 5-digit ZIP code.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const place = await lookupPostalCode(normalized);
      if (!place) {
        setError(`ZIP ${normalized} is not in our ZIP list. Check it, or try a nearby ZIP.`);
        return;
      }
      await home.setHome(normalized, radius);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const options = RADIUS_OPTIONS.includes(radius) ? RADIUS_OPTIONS : [...RADIUS_OPTIONS, radius].sort((a, b) => a - b);

  // Portalled to <body>: the trigger can sit inside another form (the web header's search).
  return createPortal(
    <dialog ref={ref} className="sheet" aria-labelledby={`${zipId}-title`} onClose={onClose}>
      <form className="sheet__body" onSubmit={submit} noValidate>
        <div className="sheet__head">
          <h2 id={`${zipId}-title`} className="sheet__title">
            Where you bid from
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="muted small">
          Results are ranked by distance from this ZIP.{' '}
          {user ? 'It is saved to your profile.' : 'It is kept on this device until you sign in.'}
        </p>
        <div className="field-grid">
          <div className="field">
            <label htmlFor={zipId}>Home ZIP</label>
            <input
              id={zipId}
              className="input"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={10}
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor={radiusId}>Drive up to</label>
            <select id={radiusId} className="input" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
              {options.map((r) => (
                <option key={r} value={r}>
                  {r} mi
                </option>
              ))}
            </select>
          </div>
        </div>
        {error ? (
          <p id={errorId} className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Checking…' : 'Use this location'}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}

/** The "53202 · 50 mi" pill that opens the dialog. */
export function LocationButton({ variant = 'pill' }: { variant?: 'pill' | 'field' }) {
  const { zip, radiusMiles } = useHome();
  const [open, setOpen] = useState(false);
  const label = zip ? `${zip} · ${radiusMiles} mi` : 'Set your ZIP';
  return (
    <>
      <button
        type="button"
        className={variant === 'pill' ? 'location-pill' : 'location-field'}
        aria-label={zip ? `Change location: ZIP ${zip}, ${radiusMiles} miles` : 'Set your home ZIP code'}
        onClick={() => setOpen(true)}
      >
        {variant === 'pill' ? <PinIcon size={16} strokeWidth={2} /> : null}
        <span>{label}</span>
      </button>
      <LocationDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
