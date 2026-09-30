import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BackIcon, ShareIcon } from './Icons';

/**
 * The lot page's top bar (Lot.dc.html): back, the source's name, share. Back
 * goes to the page before, or to `from` (the search or hunt that linked here)
 * when the lot was opened directly.
 */
export function LotHead({
  sourceName,
  title,
  from,
  shareLabel,
}: {
  sourceName: string;
  title: string;
  from: string | null;
  shareLabel: string;
}) {
  const navigate = useNavigate();
  const [shareNote, setShareNote] = useState<string | null>(null);

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareNote('Link copied');
      }
    } catch {
      // The user closed the share sheet.
    }
  }

  return (
    <>
      <header className="lot-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(from ?? '/'))}
        >
          <BackIcon />
        </button>
        <span className="lot-head__source">{sourceName}</span>
        <button type="button" className="icon-btn" aria-label={shareLabel} onClick={share}>
          <ShareIcon size={20} strokeWidth={2} />
        </button>
      </header>
      {shareNote ? (
        <p className="toast" role="status">
          {shareNote}
        </p>
      ) : null}
    </>
  );
}
