import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Toaster } from 'sonner'
import { Moon, Settings as SettingsIcon, Sun } from 'lucide-react'
import Ports from './pages/Ports'
import SettingsDialog from './components/SettingsDialog'
import { SettingsProvider } from './settings/SettingsProvider'
import { useSettings } from './settings/settings-context'
import { createPortmanApi, getAutostartFromOs } from './api/portman'
import { stablePortRowKey, type KillResult, type Port } from './types'
import './styles/global.css'

function AppShell() {
  const { settings, updateSetting } = useSettings()
  const api = useMemo(() => createPortmanApi(), [])

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isLive, setIsLive] = useState(true)
  const [ports, setPorts] = useState<Port[]>([])
  const [loading, setLoading] = useState(true)
  const [changedKeys, setChangedKeys] = useState<Set<string>>(new Set())

  const prevSnap = useRef<Map<string, string>>(new Map())
  const portsFetchGen = useRef(0)

  const refreshIntervalMs = Math.max(1, settings.refreshInterval) * 1000

  const refreshPorts = useCallback(async (opts?: { silent?: boolean }) => {
    const gen = ++portsFetchGen.current
    if (!opts?.silent) setLoading(true)
    try {
      const result = await api.getPorts()
      if (gen !== portsFetchGen.current) return
      const nextPorts = result.ports

      const snap = new Map<string, string>()
      const ch = new Set<string>()
      for (const p of nextPorts) {
        const k = stablePortRowKey(p)
        const sig = `${p.state}|${p.process_name ?? ''}|${p.local_address}|${p.pid ?? ''}`
        snap.set(k, sig)
        const old = prevSnap.current.get(k)
        if (old !== undefined && old !== sig) {
          ch.add(k)
        }
      }
      prevSnap.current = snap
      setChangedKeys(ch)

      setPorts(nextPorts)
    } catch (error) {
      console.error('Failed to fetch ports:', error)
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void refreshPorts()
  }, [refreshPorts])

  useEffect(() => {
    let cancelled = false
    void getAutostartFromOs().then((enabled) => {
      if (cancelled) return
      updateSetting('startupOnLogin', enabled === true)
    })
    return () => {
      cancelled = true
    }
  }, [updateSetting])

  useEffect(() => {
    if (!isLive) return

    const interval = setInterval(() => {
      void refreshPorts({ silent: true })
    }, refreshIntervalMs)
    return () => clearInterval(interval)
  }, [isLive, refreshPorts, refreshIntervalMs])

  useEffect(() => {
    let unlistenFn: (() => void) | undefined

    listen('refresh', () => {
      void refreshPorts()
    })
      .then((fn) => {
        unlistenFn = fn
      })
      .catch(() => {})

    return () => {
      unlistenFn?.()
    }
  }, [refreshPorts])

  // ⌘, (Ctrl+, elsewhere) opens Settings, as in other apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const handleKillPid = async (
    pid: number,
    opts?: { dryRun?: boolean; port?: number },
  ): Promise<KillResult> => {
    try {
      const result = await api.killPid(pid, { dryRun: opts?.dryRun, port: opts?.port })
      if (result.success && !result.dry_run) {
        setPorts((prev) => prev.filter((p) => p.pid !== pid))
        void refreshPorts({ silent: true })
      }
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  return (
    <div className="app">
      <header className="titlebar titlebar-drag" aria-label="Window title">
        <div className="titlebar-brand">
          <img
            className="logo-image"
            src="/portman-logo.png"
            alt=""
            width={28}
            height={28}
            draggable={false}
          />
          <span className="titlebar-title">PortMan</span>
        </div>
        <button
          type="button"
          className="titlebar-theme-btn no-drag"
          aria-label="Settings"
          title="Settings (⌘,)"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon size={16} />
        </button>
        <button
          type="button"
          className="titlebar-theme-btn no-drag"
          aria-label={settings.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          title={settings.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={() => updateSetting('theme', settings.theme === 'dark' ? 'light' : 'dark')}
        >
          {settings.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>
      <div className="app-body">
        <main className="main-content">
          <Ports
            ports={ports}
            loading={loading}
            isLive={isLive}
            onToggleLive={() => setIsLive(!isLive)}
            onKillPid={handleKillPid}
            onRefresh={refreshPorts}
            changedKeys={changedKeys}
          />
        </main>
      </div>
      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* What each action did (copied, opened, stopped…), bottom right. */}
      <Toaster theme={settings.theme} position="bottom-right" className="portman-toaster" />
    </div>
  )
}

function App() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  )
}

export default App
