import { useState, useEffect } from 'react'
import { Database } from 'lucide-react'
import { useSettings } from '../settings/settings-context'
import {
  getAutostartFromOs,
  isTauriRuntime,
  openSystemStartupSettings,
  setAutostartOnOs,
} from '../api/portman'

function Settings() {
  const { settings, updateSetting } = useSettings()
  const [dataMsg, setDataMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!dataMsg) return
    const t = window.setTimeout(() => setDataMsg(null), 4000)
    return () => clearTimeout(t)
  }, [dataMsg])

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Refresh behavior and login startup.</p>
        </div>
      </header>

      {dataMsg && <div className="settings-banner">{dataMsg}</div>}

      <div className="settings-grid">
        <div className="settings-card">
          <div className="settings-header">
            <Database size={20} />
            <h3>General</h3>
          </div>

          <div className="setting-row">
            <label>Refresh Interval</label>
            <div className="slider-control">
              <input
                type="range"
                min="1"
                max="10"
                value={settings.refreshInterval}
                onChange={(e) =>
                  updateSetting('refreshInterval', parseInt(e.target.value, 10))
                }
              />
              <span>{settings.refreshInterval}s</span>
            </div>
          </div>

          <div className="setting-row stacked startup-login-row">
            <div className="startup-login-main">
              <label title="Opens PortMan when your user session starts (system login item).">
                Startup on Login
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.startupOnLogin}
                  onChange={async (e) => {
                    const next = e.target.checked
                    if (!isTauriRuntime()) {
                      updateSetting('startupOnLogin', false)
                      setDataMsg('Launch at login requires the desktop app.')
                      return
                    }
                    try {
                      await setAutostartOnOs(next)
                      const actual = await getAutostartFromOs()
                      updateSetting('startupOnLogin', actual === true)
                    } catch (err) {
                      setDataMsg(String(err))
                      const actual = await getAutostartFromOs()
                      updateSetting('startupOnLogin', actual === true)
                    }
                  }}
                />
                <span className="slider"></span>
              </label>
            </div>
            <p className="startup-login-verify">
              <button
                type="button"
                className="settings-text-link no-drag"
                onClick={async () => {
                  if (!isTauriRuntime()) {
                    setDataMsg('Open Startup settings in the desktop app.')
                    return
                  }
                  try {
                    await openSystemStartupSettings()
                  } catch (err) {
                    setDataMsg(String(err))
                  }
                }}
              >
                Check in system settings
              </button>
              <span className="startup-login-verify-hint">
                {' '}
                — open the Login Items / Startup Apps page to verify or change outside PortMan.
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Settings
