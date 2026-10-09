import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DataError, describeError } from '../data/errors';

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'That did not load' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const auth = error instanceof DataError && error.kind === 'auth';
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      <p>{describeError(error)}</p>
      <div className="state__actions">
        {auth ? (
          <Link className="btn btn--secondary" to="/signin">
            Sign in again
          </Link>
        ) : null}
        {onRetry && !auth ? (
          <button type="button" className="btn btn--secondary" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {children ? <div className="state__body">{children}</div> : null}
      {action ? <div className="state__actions">{action}</div> : null}
    </div>
  );
}

/** Placeholder cards while a list loads (hidden from assistive tech; the status line speaks). */
export function CardSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="skeletons" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-card" key={i}>
          <div className="skeleton skeleton--photo" />
          <div className="skeleton-card__lines">
            <div className="skeleton skeleton--line skeleton--short" />
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--line skeleton--mid" />
          </div>
        </div>
      ))}
    </div>
  );
}
