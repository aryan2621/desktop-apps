import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { resolveEffectiveTheme, type PortmanSettings } from '../types'
import { SettingsContext } from './settings-context'

const STORAGE_KEY = 'portman-settings'
const ACCENT_HEX = /^#[0-9A-Fa-f]{6}$/

const defaults: PortmanSettings = {
  theme: 'dark',
  refreshInterval: 3,
  accentColor: '#6C63FF',
  startupOnLogin: false,
  hideSystem: true,
  defaultFilter: 'ALL',
  confirmByTyping: true,
}

function isThemeMode(v: unknown): v is PortmanSettings['theme'] {
  return v === 'light' || v === 'dark'
}

function clampRefreshInterval(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return defaults.refreshInterval
  return Math.min(10, Math.max(1, Math.round(n)))
}

function parseAccentColor(v: unknown): string {
  return typeof v === 'string' && ACCENT_HEX.test(v) ? v : defaults.accentColor
}

function loadSettings(): PortmanSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<PortmanSettings>
    const theme = isThemeMode(parsed.theme) ? parsed.theme : defaults.theme
    // startupOnLogin is driven by the OS (see getAutostartFromOs); never trust localStorage
    return {
      theme,
      refreshInterval: clampRefreshInterval(parsed.refreshInterval),
      accentColor: parseAccentColor(parsed.accentColor),
      startupOnLogin: defaults.startupOnLogin,
      hideSystem: typeof parsed.hideSystem === 'boolean' ? parsed.hideSystem : defaults.hideSystem,
      defaultFilter: parsed.defaultFilter === 'LISTEN' ? 'LISTEN' : defaults.defaultFilter,
      confirmByTyping:
        typeof parsed.confirmByTyping === 'boolean' ? parsed.confirmByTyping : defaults.confirmByTyping,
    }
  } catch {
    return defaults
  }
}

function applyThemeTokens(settings: PortmanSettings) {
  const root = document.documentElement
  const effective = resolveEffectiveTheme(settings.theme)
  root.dataset.theme = effective
  root.style.colorScheme = effective
  root.style.removeProperty('--primary')
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PortmanSettings>(() => {
    const loaded = loadSettings()
    applyThemeTokens(loaded)
    return loaded
  })

  useEffect(() => {
    applyThemeTokens(settings)
  }, [settings.theme])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const updateSetting = useCallback(<K extends keyof PortmanSettings>(
    key: K,
    value: PortmanSettings[K],
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }, [])

  const value = useMemo(
    () => ({ settings, setSettings, updateSetting }),
    [settings, updateSetting],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
