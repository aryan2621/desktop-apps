import { useEffect, useMemo, useRef, useState } from 'react'
import type { MenuEntry, MenuItem } from './Menu'
import { IconSearch } from './Icons'

interface Props {
  entries: MenuEntry[]
  onClose: () => void
}

/** ⌘K: every app action by name, with its shortcut. Arrows move, Enter runs, Escape closes. */
export function CommandPalette({ entries, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const items = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return entries
      .filter((e): e is MenuItem => e !== 'separator')
      .filter((e) => words.every((w) => e.label.toLowerCase().includes(w)))
      // Things you can do now come first.
      .sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled))
  }, [entries, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return
    onClose()
    item.onSelect()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <IconSearch />
          <input
            autoFocus
            placeholder="Type a command…"
            aria-label="Search commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(items.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(items[active])
              }
            }}
          />
        </div>
        <ul ref={list} className="palette-list" role="listbox">
          {items.map((item, i) => (
            <li
              key={item.label}
              role="option"
              aria-selected={i === active}
              aria-disabled={item.disabled}
              className={`palette-item${i === active ? ' active' : ''}${item.disabled ? ' disabled' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(item)}
            >
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </li>
          ))}
          {items.length === 0 && <li className="palette-empty hint">No matching commands</li>}
        </ul>
      </div>
    </div>
  )
}
