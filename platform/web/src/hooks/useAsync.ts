import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface AsyncState<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  /** Run the loader again (after an error, or when the data changed elsewhere). */
  readonly reload: () => void;
  /** Replace the data locally, for optimistic updates. */
  readonly setData: (update: T | ((current: T | undefined) => T)) => void;
}

/**
 * Runs `load` whenever `deps` change and tracks loading and error state. A
 * result that arrives after a newer request started is dropped, so a slow
 * response can never overwrite a fresher one. Pass `enabled = false` to wait.
 */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList, enabled = true): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((value) => {
        if (id !== latest.current) return;
        setDataState(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (id !== latest.current) return;
        console.warn(err);
        setError(err);
        setLoading(false);
      });
    // The caller owns the dependency list; `load` is read through a ref.
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((update: T | ((current: T | undefined) => T)) => {
    setDataState((current) => (typeof update === 'function' ? (update as (c: T | undefined) => T)(current) : update));
  }, []);

  return { data, error, loading, reload, setData };
}
