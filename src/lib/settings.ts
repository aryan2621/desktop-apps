import { useSyncExternalStore } from 'react'

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  /** How JSON files open; `auto` picks table for records and JSON for everything else. */
  jsonView: 'auto' | 'table' | 'json'
  density: 'comfortable' | 'compact'
  /** Alternate row shading in the table. */
  rowStyle: 'plain' | 'striped'
}

const SETTINGS_KEY = 'bigview.settings'
const RECENT_KEY = 'bigview.recent'
const DEFAULTS: Settings = { theme: 'system', jsonView: 'auto', density: 'comfortable', rowStyle: 'plain' }

/** Grid row height and JSON view line height per density. */
export const ROW_HEIGHT: Record<Settings['density'], number> = { comfortable: 30, compact: 24 }
export const LINE_HEIGHT: Record<Settings['density'], number> = { comfortable: 22, compact: 18 }

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Settings and recent files are conveniences; ignore storage failures.
  }
}

let settings: Settings = { ...DEFAULTS, ...read<Partial<Settings>>(SETTINGS_KEY, {}) }
let recent: string[] = (() => {
  const list = read<unknown>(RECENT_KEY, [])
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
})()
const listeners = new Set<() => void>()
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => listeners.delete(f)
}
const notify = () => listeners.forEach((f) => f())

/** Same mechanism as agentic-browser: no attribute follows the OS, otherwise it forces one. */
function applyTheme(theme: Settings['theme']) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}
applyTheme(settings.theme)

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  write(SETTINGS_KEY, settings)
  applyTheme(settings.theme)
  notify()
}

export const getSettings = () => settings
export const useSettings = () => useSyncExternalStore(subscribe, getSettings)

function setRecent(list: string[]) {
  recent = list
  write(RECENT_KEY, list)
  notify()
}

export const useRecent = () => useSyncExternalStore(subscribe, () => recent)
export const rememberRecent = (path: string) => setRecent([path, ...recent.filter((p) => p !== path)].slice(0, 8))
export const removeRecent = (path: string) => setRecent(recent.filter((p) => p !== path))
export const clearRecent = () => setRecent([])
export const removeRecentMany = (paths: string[]) => {
  const drop = new Set(paths)
  setRecent(recent.filter((p) => !drop.has(p)))
}
