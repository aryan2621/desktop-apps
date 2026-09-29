import { useCallback, useRef, useState } from 'react';

const COALESCE_MS = 700;
const LIMIT = 200;

/**
 * Undo/redo for an immutable value. Changes with the same `key` made in quick succession
 * (dragging a slider or a timeline handle) collapse into a single undo step.
 */
export function useHistory<T>(initial: T) {
    const [state, setState] = useState({ past: [] as T[], present: initial, future: [] as T[] });
    const last = useRef<{ key?: string; at: number }>({ at: 0 });

    const set = useCallback((update: T | ((current: T) => T), key?: string) => {
        setState(({ past, present, future }) => {
            const next = typeof update === 'function' ? (update as (current: T) => T)(present) : update;
            if (next === present) return { past, present, future };
            const now = Date.now();
            const coalesce = key !== undefined && last.current.key === key && now - last.current.at < COALESCE_MS;
            last.current = { key, at: now };
            if (coalesce) return { past, present: next, future: [] };
            return { past: [...past, present].slice(-LIMIT), present: next, future: [] };
        });
    }, []);

    const undo = useCallback(() => {
        last.current = { at: 0 };
        setState(({ past, present, future }) =>
            past.length === 0 ? { past, present, future } : { past: past.slice(0, -1), present: past[past.length - 1], future: [present, ...future] }
        );
    }, []);

    const redo = useCallback(() => {
        last.current = { at: 0 };
        setState(({ past, present, future }) =>
            future.length === 0 ? { past, present, future } : { past: [...past, present], present: future[0], future: future.slice(1) }
        );
    }, []);

    /** Replaces the value and clears history (used after loading). */
    const reset = useCallback((value: T) => {
        last.current = { at: 0 };
        setState({ past: [], present: value, future: [] });
    }, []);

    return { value: state.present, set, undo, redo, reset, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
