import { createContext, useContext } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PortmanSettings } from '../types'

export interface SettingsContextValue {
  settings: PortmanSettings
  setSettings: Dispatch<SetStateAction<PortmanSettings>>
  updateSetting: <K extends keyof PortmanSettings>(key: K, value: PortmanSettings[K]) => void
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error('useSettings must be used within SettingsProvider')
  }
  return ctx
}
