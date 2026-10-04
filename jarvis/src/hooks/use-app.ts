import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, events, type AppState, type Entry } from "@/lib/api";

/** Live app state (config, permissions, Ollama, status) refreshed on focus and status changes. */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await api.state();
      if (id === request.current) setState(next);
    } catch (error) {
      if (id === request.current) toast.error(`Couldn't load app state: ${error}`, { id: "app-state-error" });
    }
  }, []);

  useEffect(() => {
    refresh();
    const unStatus = events.status((status) => {
      setState((s) => (s ? { ...s, status } : s));
      if (status.startsWith("Ready")) refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      ++request.current;
      unStatus.then((u) => u());
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return { state, setState, refresh };
}

/** Question/answer history, refreshed whenever a new answer is saved. */
export function useHistory(query = "", limit?: number) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await api.history(query, limit);
      if (id === request.current) setEntries(next);
    } catch (error) {
      if (id === request.current) toast.error(`Couldn't load history: ${error}`, { id: "history-error" });
    }
  }, [query, limit]);

  useEffect(() => {
    setEntries(null);
    refresh();
    const un = events.historyUpdated(refresh);
    return () => {
      ++request.current;
      un.then((u) => u());
    };
  }, [refresh]);

  return { entries, refresh };
}
