import { useCallback, useEffect, useRef, useState } from "react";
import { VaultError } from "./client";

// Keep results in command memory only. Key changes and aborted requests cannot
// expose a previous query/record while the next request is loading.
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true, delay = 0) {
  const [revision, setRevision] = useState(0);
  const [request, setRequest] = useState({ key, enabled, revision, id: 0 });
  // Request identity is state, rather than a memoized object reference. This
  // also distinguishes A -> B -> A when B never finished loading.
  if (request.key !== key || request.enabled !== enabled || request.revision !== revision) {
    setRequest({ key, enabled, revision, id: request.id + 1 });
  }
  const [state, setState] = useState<{
    requestId: number;
    value?: T;
    error?: VaultError;
    loading: boolean;
  }>({ requestId: -1, loading: true });
  const loader = useRef(load);
  loader.current = load;
  const generation = `${request.id}:${key}`;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const value = await loader.current(controller.signal);
        if (!controller.signal.aborted) setState({ requestId: request.id, value, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            requestId: request.id,
            error: error instanceof VaultError ? error : new VaultError("加载失败，请重试。"),
            loading: false,
          });
      }
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request.id, enabled, delay]);
  const current =
    enabled && request.key === key && request.revision === revision && state.requestId === request.id
      ? state
      : undefined;
  return {
    value: current?.value,
    error: current?.error,
    loading: enabled && (current?.loading ?? true),
    generation,
    refresh: useCallback(() => setRevision((value) => value + 1), []),
  };
}
