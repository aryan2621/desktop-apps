import { useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'capturita.theme';
const media = window.matchMedia('(prefers-color-scheme: light)');
const listeners = new Set<() => void>();

let choice: ThemeChoice = readChoice();

function readChoice(): ThemeChoice {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
        return 'system';
    }
}

const effective = (): Theme => (choice === 'system' ? (media.matches ? 'light' : 'dark') : choice);

/** Puts the theme on <html> (index.css reads data-theme) and on the native windows. */
function apply() {
    document.documentElement.dataset.theme = effective();
    const native = choice === 'system' ? null : choice;
    // The title bar, and the helper's control bar and camera bubble, follow the same choice.
    getCurrentWindow()
        .setTheme(native)
        .catch(() => {});
    invoke('recorder_request', { cmd: 'setAppearance', args: { mode: choice } }).catch(() => {});
    listeners.forEach((listener) => listener());
}

/** Call once before the first render so the app never flashes in the wrong theme. */
export function initTheme() {
    document.documentElement.dataset.theme = effective();
    media.addEventListener('change', () => {
        if (choice === 'system') apply();
    });
    apply();
}

export function setThemeChoice(next: ThemeChoice) {
    choice = next;
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // The choice just won't be remembered.
    }
    apply();
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The user's choice and the theme actually shown. */
export function useTheme() {
    const current = useSyncExternalStore(subscribe, () => choice);
    const shown = useSyncExternalStore(subscribe, effective);
    return { choice: current, theme: shown, setChoice: setThemeChoice };
}
