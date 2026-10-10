import { useEffect, useRef, useState } from 'react'
import { IconMore } from './Icons'

export interface MenuItem {
  label: string
  shortcut?: string
  disabled?: boolean
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'separator'

interface MenuProps {
  entries: MenuEntry[]
  /** Viewport point the menu opens at; it keeps itself on screen. */
  at: { x: number; y: number; alignRight?: boolean }
  onClose: () => void
}

/** Popup menu in the dropdown style shared with agentic-browser. Arrows move, Enter picks, Escape closes. */
export function Menu({ entries, at, onClose }: MenuProps) {
  const root = useRef<HTMLUListElement>(null)
  const items = entries.map((e, i) => ({ e, i })).filter((x): x is { e: MenuItem; i: number } => x.e !== 'separator')
  const [active, setActive] = useState(-1)

  useEffect(() => {
    root.current?.focus()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const pick = (item: MenuItem) => {
    if (item.disabled) return
    onClose()
    item.onSelect()
  }

  const move = (dir: 1 | -1) => {
    const enabled = items.filter((x) => !x.e.disabled)
    if (enabled.length === 0) return
    const pos = enabled.findIndex((x) => x.i === active)
    const next = enabled[(pos + dir + enabled.length) % enabled.length]
    setActive(next.i)
  }

  const style: React.CSSProperties = at.alignRight
    ? { top: at.y, right: Math.max(8, window.innerWidth - at.x) }
    : { top: at.y, left: Math.min(at.x, window.innerWidth - 260) }

  return (
    <ul
      ref={root}
      className="dropdown-menu menu"
      role="menu"
      tabIndex={-1}
      style={style}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const hit = items.find((x) => x.i === active)
          if (hit) pick(hit.e)
        }
      }}
    >
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <li key={i} className="menu-separator" role="separator" />
        ) : (
          <li
            key={i}
            role="menuitem"
            aria-disabled={entry.disabled}
            className={`dropdown-option menu-item${i === active ? ' active' : ''}${entry.disabled ? ' disabled' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(entry)}
          >
            <span className="dropdown-label">{entry.label}</span>
            {entry.shortcut && <span className="menu-shortcut">{entry.shortcut}</span>}
          </li>
        ),
      )}
    </ul>
  )
}

/** The ⋮ button with every action of the app, so nothing is shortcut-only. */
export function AppMenu({ entries }: { entries: MenuEntry[] }) {
  const [at, setAt] = useState<MenuProps['at'] | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={button}
        className="icon-btn"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => {
          if (at) return setAt(null)
          const r = button.current!.getBoundingClientRect()
          setAt({ x: r.right, y: r.bottom + 6, alignRight: true })
        }}
      >
        <IconMore />
      </button>
      {at && (
        <Menu
          entries={entries}
          at={at}
          onClose={() => {
            setAt(null)
            button.current?.focus()
          }}
        />
      )}
    </>
  )
}
