import { useState, type ReactNode } from 'react'
import { clearRecent, removeRecent, updateSettings, useRecent, useSettings } from '../lib/settings'
import { Dropdown } from './Dropdown'
import { IconSearch } from './Icons'

// Same stroke style as the shared icons; kept here because only Settings uses them.
const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)
export const IconSettings = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
)
const IconAppearance = () => (
  <Svg>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
)
const IconFiles = () => (
  <Svg>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </Svg>
)
const IconHistory = () => (
  <Svg>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Svg>
)

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: IconAppearance },
  { id: 'files', label: 'Opening files', icon: IconFiles },
  { id: 'recent', label: 'Recent files', icon: IconHistory },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** One line under each section's title. */
const DESCRIPTIONS: Record<SectionId, string> = {
  appearance: 'Theme, row spacing and shading.',
  files: 'How JSON files are shown when they open.',
  recent: 'Files listed on the start page.',
}

/** Extra words the settings search matches per section (besides its label). */
const KEYWORDS: Record<SectionId, string> = {
  appearance: 'theme dark light system density compact comfortable row height stripes striped shading zebra',
  files: 'json table view default auto open',
  recent: 'recent history clear remove files',
}

/** A section's title with its icon and a short description. */
function SectionHeader({ id }: { id: SectionId }) {
  const def = SECTIONS.find((x) => x.id === id)!
  const Icon = def.icon
  return (
    <header className="settings-section-header">
      <span className="settings-section-icon" aria-hidden="true">
        <Icon />
      </span>
      <div>
        <h2>{def.label}</h2>
        <p className="hint">{DESCRIPTIONS[id]}</p>
      </div>
    </header>
  )
}

function SettingRow({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-title">{title}</span>
        <span className="hint">{hint}</span>
      </div>
      {children}
    </div>
  )
}

export function Settings({ onOpen }: { onOpen: (path: string) => void }) {
  const settings = useSettings()
  const recent = useRecent()
  const [section, setSection] = useState<SectionId>('appearance')
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const shown = SECTIONS.filter((x) => !q || x.label.toLowerCase().includes(q) || KEYWORDS[x.id].includes(q))
  const current = q && !shown.some((x) => x.id === section) ? (shown[0]?.id ?? section) : section

  return (
    <div className="settings-page">
      <aside className="settings-side">
        <h1 className="settings-title">
          <IconSettings /> Settings
        </h1>
        <nav className="settings-nav" aria-label="Settings sections">
          {shown.map((x) => {
            const Icon = x.icon
            return (
              <div key={x.id} className="settings-nav-item">
                <button
                  className={current === x.id ? 'active' : ''}
                  aria-current={current === x.id ? 'page' : undefined}
                  onClick={() => {
                    setSection(x.id)
                    setQuery('')
                  }}
                >
                  <Icon /> {x.label}
                </button>
              </div>
            )
          })}
          {shown.length === 0 && <p className="hint">No settings match.</p>}
        </nav>
      </aside>
      <main className="settings-main">
        <div className="settings-search">
          <IconSearch />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="settings-content">
          {current === 'appearance' && (
            <>
              <SectionHeader id="appearance" />
              <div className="settings-card">
                <SettingRow title="Theme" hint="Light, dark, or match your computer.">
                  <Dropdown
                    ariaLabel="Theme"
                    align="right"
                    value={settings.theme}
                    onChange={(theme) => updateSettings({ theme })}
                    options={[
                      { value: 'system', label: 'Follow system', description: 'Switches with your OS appearance.' },
                      { value: 'light', label: 'Light', description: 'Always light.' },
                      { value: 'dark', label: 'Dark', description: 'Always dark.' },
                    ]}
                  />
                </SettingRow>
                <SettingRow title="Row density" hint="Row height in the table and line height in the JSON view.">
                  <Dropdown
                    ariaLabel="Row density"
                    align="right"
                    value={settings.density}
                    onChange={(density) => updateSettings({ density })}
                    options={[
                      { value: 'comfortable', label: 'Comfortable', description: 'Roomier rows, easier to read.' },
                      { value: 'compact', label: 'Compact', description: 'More rows on screen.' },
                    ]}
                  />
                </SettingRow>
                <SettingRow title="Row shading" hint="Alternate row backgrounds make wide rows easier to follow.">
                  <Dropdown
                    ariaLabel="Row shading"
                    align="right"
                    value={settings.rowStyle}
                    onChange={(rowStyle) => updateSettings({ rowStyle })}
                    options={[
                      { value: 'plain', label: 'Plain', description: 'Every row has the same background.' },
                      { value: 'striped', label: 'Striped', description: 'Every other row is shaded.' },
                    ]}
                  />
                </SettingRow>
              </div>
            </>
          )}

          {current === 'files' && (
            <>
              <SectionHeader id="files" />
              <div className="settings-card">
                <SettingRow title="Default view for JSON files" hint="You can still switch with the Table / JSON chips.">
                  <Dropdown
                    ariaLabel="Default view for JSON files"
                    align="right"
                    value={settings.jsonView}
                    onChange={(jsonView) => updateSettings({ jsonView })}
                    options={[
                      {
                        value: 'auto',
                        label: 'Automatic',
                        description: 'Table for lists of records, JSON for everything else.',
                      },
                      { value: 'table', label: 'Table', description: 'Always open as a table.' },
                      { value: 'json', label: 'JSON', description: 'Always open as a JSON tree.' },
                    ]}
                  />
                </SettingRow>
              </div>
            </>
          )}

          {current === 'recent' && (
            <>
              <SectionHeader id="recent" />
              <div className="settings-card">
                {recent.length === 0 ? (
                  <p className="hint">Files you open appear here and on the start page.</p>
                ) : (
                  <>
                    <ul className="settings-list">
                      {recent.map((path) => (
                        <li key={path} className="row gap">
                          <button className="settings-list-main grow" title={`Open ${path}`} onClick={() => onOpen(path)}>
                            <strong>{path.split(/[\\/]/).pop()}</strong>
                            <span className="hint">{path}</span>
                          </button>
                          <button className="btn subtle" onClick={() => removeRecent(path)}>
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button className="btn" onClick={clearRecent}>
                      Clear all
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
