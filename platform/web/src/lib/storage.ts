/**
 * localStorage for per-device conveniences only (the signed-out home ZIP, the
 * page to return to after sign-in). Every access is guarded: storage can be
 * missing or throw in private windows, and the app must work without it.
 */

const PREFIX = 'skeuos:';

export function readStored<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the value lives for this page view only.
  }
}

export function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to do.
  }
}
