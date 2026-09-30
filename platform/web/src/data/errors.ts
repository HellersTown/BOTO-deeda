/**
 * Every data-layer failure becomes a DataError with a `kind` the UI can act on.
 * The raw PostgREST message is kept for the console, never shown as-is.
 */

export type DataErrorKind =
  | 'network'
  | 'auth'
  | 'not_found'
  | 'hunt_limit'
  | 'permission'
  | 'config'
  | 'invalid'
  | 'unknown';

export class DataError extends Error {
  readonly kind: DataErrorKind;
  readonly code: string | null;
  /** The backend's own words, for a message that is safe to show (the hunt-limit trigger's text). */
  readonly detail: string | null;

  constructor(message: string, kind: DataErrorKind, code: string | null = null, detail: string | null = null) {
    super(message);
    this.name = 'DataError';
    this.kind = kind;
    this.code = code;
    this.detail = detail;
  }
}

/** The fields of a PostgrestError / AuthError that we read. */
export interface BackendErrorLike {
  readonly message?: string;
  readonly code?: string | number | null;
  readonly details?: string | null;
  readonly hint?: string | null;
  readonly status?: number;
}

const NETWORK = /failed to fetch|networkerror|load failed|fetch failed|network request failed/i;

/** 0003/0004 raise these from the hunt-limit triggers, errcode check_violation (23514). */
const HUNT_LIMIT = /hunt limit reached|photo-matched hunts are a paid feature|photo-hunt limit reached/i;

export function classify(err: BackendErrorLike): DataErrorKind {
  const message = err.message ?? '';
  const code = err.code === undefined || err.code === null ? '' : String(err.code);
  if (NETWORK.test(message)) return 'network';
  if (HUNT_LIMIT.test(message)) return 'hunt_limit';
  if (code === 'PGRST301' || code === 'PGRST302' || /jwt/i.test(message)) return 'auth';
  if (code === '42501') return 'permission';
  if (code === 'P0002' || code === 'PGRST116' || /not found/i.test(message)) return 'not_found';
  if (code === '22P02' || code === '23514' || code === '23502') return 'invalid';
  return 'unknown';
}

export function toDataError(err: unknown, context: string): DataError {
  if (err instanceof DataError) return err;
  const like: BackendErrorLike =
    err !== null && typeof err === 'object' ? (err as BackendErrorLike) : { message: String(err) };
  const kind = classify(like);
  const code = like.code === undefined || like.code === null ? null : String(like.code);
  const detail = kind === 'hunt_limit' ? (like.message ?? null) : null;
  return new DataError(`${context}: ${like.message ?? 'unknown error'}`, kind, code, detail);
}

/** Plain words for a failure, for error states. */
export function describeError(err: unknown): string {
  const kind = err instanceof DataError ? err.kind : 'unknown';
  switch (kind) {
    case 'network':
      return 'Skeuos could not reach its server. Check your connection and try again.';
    case 'auth':
      return 'Your session has ended. Sign in again to continue.';
    case 'not_found':
      return 'That could not be found. It may have been removed.';
    case 'permission':
      return 'Your account is not allowed to do that.';
    case 'hunt_limit':
      return (err as DataError).detail ?? 'Your plan’s hunt limit is reached.';
    case 'config':
      return (err as DataError).message;
    case 'invalid':
      return 'The server did not accept that value. Check it and try again.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}
