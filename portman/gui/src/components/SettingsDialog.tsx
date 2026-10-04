import { type ReactNode } from 'react'
import { toast } from 'sonner'
import { Moon, Sun } from 'lucide-react'
import Modal from './Modal'
import { useSettings } from '../settings/settings-context'
import {
  getAutostartFromOs,
  isTauriRuntime,
  openSystemStartupSettings,
  setAutostartOnOs,
} from '../api/portman'

interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="slider"></span>
    </label>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const { settings, updateSetting } = useSettings()

  const setStartup = async (next: boolean) => {
    if (!isTauriRuntime()) {
      updateSetting('startupOnLogin', false)
      toast.error('Launch at login needs the desktop app.')
      return
    }
    try {
      await setAutostartOnOs(next)
    } catch (err) {
      toast.error(String(err))
    }
    const actual = (await getAutostartFromOs()) === true
    updateSetting('startupOnLogin', actual)
    if (actual === next) {
      toast.success(actual ? 'PortMan will open when you log in' : "PortMan won't open at login")
    }
  }

  const openStartupSettings = async () => {
    if (!isTauriRuntime()) {
      toast.error('Open Startup settings in the desktop app.')
      return
    }
    try {
      await openSystemStartupSettings()
    } catch (err) {
      toast.error(String(err))
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings" size="medium">
      <div className="settings-dialog">

        <section className="settings-section">
          <h4>General</h4>
          <Row label="Appearance">
            <div className="theme-toggle" role="radiogroup" aria-label="Appearance">
              {(['light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === mode}
                  className={`no-drag ${settings.theme === mode ? 'active' : ''}`}
                  onClick={() => updateSetting('theme', mode)}
                >
                  {mode === 'light' ? <Sun size={14} /> : <Moon size={14} />}
                  {mode === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Refresh every" hint="How often the list updates while Live is on.">
            <div className="slider-control">
              <input
                type="range"
                min="1"
                max="10"
                aria-label="Refresh interval in seconds"
                value={settings.refreshInterval}
                onChange={(e) => updateSetting('refreshInterval', parseInt(e.target.value, 10))}
              />
              <span>{settings.refreshInterval}s</span>
            </div>
          </Row>
          <Row
            label="Open at login"
            hint={
              <>
                Starts PortMan when you log in.{' '}
                <button
                  type="button"
                  className="settings-text-link no-drag"
                  onClick={() => void openStartupSettings()}
                >
                  Check in system settings
                </button>
              </>
            }
          >
            <Switch
              label="Open at login"
              checked={settings.startupOnLogin}
              onChange={(next) => void setStartup(next)}
            />
          </Row>
        </section>

        <section className="settings-section">
          <h4>Ports list</h4>
          <Row label="Show when opened" hint="The filter PortMan starts with.">
            <div className="theme-toggle" role="radiogroup" aria-label="Show when opened">
              {(
                [
                  ['ALL', 'All'],
                  ['LISTEN', 'Listening'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={settings.defaultFilter === value}
                  className={`no-drag ${settings.defaultFilter === value ? 'active' : ''}`}
                  onClick={() => updateSetting('defaultFilter', value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row
            label="Hide system ports"
            hint="Ports held by the operating system itself (Control Center, AirPlay…)."
          >
            <Switch
              label="Hide system ports"
              checked={settings.hideSystem}
              onChange={(next) => updateSetting('hideSystem', next)}
            />
          </Row>
        </section>

        <section className="settings-section">
          <h4>Safety</h4>
          <Row
            label="Type to confirm kills"
            hint="Ask for the port number (or KILL for several) before stopping a process."
          >
            <Switch
              label="Type to confirm kills"
              checked={settings.confirmByTyping}
              onChange={(next) => updateSetting('confirmByTyping', next)}
            />
          </Row>
        </section>

        <p className="settings-version">PortMan v{__APP_VERSION__}</p>
      </div>
    </Modal>
  )
}

export default SettingsDialog
