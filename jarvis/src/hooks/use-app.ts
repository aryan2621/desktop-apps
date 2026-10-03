import { useCallback, useEffect, useState } from "react";
import { api, events, type AppState, type Entry } from "@/lib/api";

/** Live app state (config, permissions, Ollama, status) refreshed on focus and status changes. */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const refresh = useCallback(() => api.state().then(setState), []);

  useEffect(() => {
    refresh();
    const unStatus = events.status((status) => {
      setState((s) => (s ? { ...s, status } : s));
      if (status.startsWith("Ready")) refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      unStatus.then((u) => u());
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return { state, setState, refresh };
}

/** Question/answer history, refreshed whenever a new answer is saved. */
export function useHistory(query = "", limit?: number) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const refresh = useCallback(() => {
    api.history(query, limit).then(setEntries);
  }, [query, limit]);

  useEffect(() => {
    refresh();
    const un = events.historyUpdated(refresh);
    return () => {
      un.then((u) => u());
    };
  }, [refresh]);

  return { entries, refresh };
}
