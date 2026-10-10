import { useEffect, useMemo, useRef, useState } from 'react'
import { api, CANCELLED, errorText, formatCount, type Filter, type FilterKind } from '../lib/api'
import { Dropdown, type DropdownOption } from './Dropdown'

const KINDS: DropdownOption<FilterKind>[] = [
  { value: 'contains', label: 'Contains', description: 'Text anywhere in the cell' },
  { value: 'notContains', label: "Doesn't contain" },
  { value: 'equals', label: 'Is exactly', description: 'The whole cell' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'regex', label: 'Matches pattern', description: 'Regular expression' },
  { value: 'oneOf', label: 'Is one of', description: 'Pick from the most common values' },
  { value: 'eq', label: '= (number)' },
  { value: 'ne', label: '≠ (number)' },
  { value: 'gt', label: '> (number)' },
  { value: 'lt', label: '< (number)' },
  { value: 'between', label: 'Between (numbers)', description: 'Both ends included' },
  { value: 'empty', label: 'Is empty' },
  { value: 'notEmpty', label: 'Is not empty' },
]

const TEXT_KINDS: FilterKind[] = ['contains', 'notContains', 'equals', 'startsWith', 'regex']
const NUMBER_KINDS: FilterKind[] = ['eq', 'ne', 'gt', 'lt', 'between']

interface Props {
  id: number
  column: string
  col: number
  initial?: Filter
  at: { x: number; y: number }
  onApply: (filter: Filter) => void
  onRemove?: () => void
  onClose: () => void
}

/** Popover that builds one column filter. */
export function FilterEditor({ id, column, col, initial, at, onApply, onRemove, onClose }: Props) {
  const [kind, setKind] = useState<FilterKind>(initial?.kind ?? 'contains')
  const [value, setValue] = useState(initial?.value ?? '')
  const [value2, setValue2] = useState(initial?.value2 ?? '')
  const [matchCase, setMatchCase] = useState(initial?.matchCase ?? false)
  const [picked, setPicked] = useState<Set<string>>(new Set(initial?.values ?? []))
  const [values, setValues] = useState<[string, number][] | null>(null)
  const [valuesError, setValuesError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  // The value list comes from the column's stats (most common values first).
  useEffect(() => {
    if (kind !== 'oneOf' || values) return
    let live = true
    api
      .columnStats(id, col)
      .then((s) => live && setValues(s.top))
      .catch((e) => live && setValuesError(errorText(e) === CANCELLED ? 'Cancelled' : errorText(e)))
    return () => {
      live = false
    }
  }, [kind, values, id, col])

  const shown = useMemo(() => {
    const all = values ?? []
    // Keep values picked earlier visible even if they aren't among the top ones now.
    const extra = [...picked].filter((v) => !all.some(([x]) => x === v)).map((v) => [v, 0] as [string, number])
    const list = [...extra, ...all]
    const q = search.toLowerCase()
    return q ? list.filter(([v]) => v.toLowerCase().includes(q)) : list
  }, [values, picked, search])

  const needsValue = TEXT_KINDS.includes(kind) || NUMBER_KINDS.includes(kind)
  const ready =
    kind === 'oneOf' ? picked.size > 0 : !needsValue || (value.trim() !== '' && (kind !== 'between' || value2.trim() !== ''))

  const apply = () => {
    if (!ready) return
    onApply({ col, kind, value, value2, values: kind === 'oneOf' ? [...picked] : [], matchCase })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault()
      apply()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      ref={root}
      className="popover filter-editor"
      role="dialog"
      aria-label={`Filter ${column}`}
      style={{ top: Math.min(at.y, window.innerHeight - 420), left: Math.max(8, Math.min(at.x, window.innerWidth - 336)) }}
      onKeyDown={onKeyDown}
    >
      <span className="popover-title">Filter “{column}”</span>
      <Dropdown value={kind} options={KINDS} onChange={setKind} ariaLabel="Condition" />
      {needsValue && (
        <div className="filter-values">
          <input
            ref={input}
            value={value}
            spellCheck={false}
            inputMode={NUMBER_KINDS.includes(kind) ? 'decimal' : undefined}
            placeholder={NUMBER_KINDS.includes(kind) ? 'Number' : kind === 'regex' ? 'Pattern' : 'Text'}
            onChange={(e) => setValue(e.target.value)}
          />
          {kind === 'between' && (
            <>
              <span className="hint">and</span>
              <input value={value2} inputMode="decimal" placeholder="Number" onChange={(e) => setValue2(e.target.value)} />
            </>
          )}
        </div>
      )}
      {TEXT_KINDS.includes(kind) && (
        <label className="option-row">
          <span>Match case</span>
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
        </label>
      )}
      {kind === 'oneOf' && (
        <div className="value-picker">
          <input ref={input} value={search} placeholder="Search values" onChange={(e) => setSearch(e.target.value)} />
          <div className="value-list" role="listbox" aria-multiselectable="true">
            {!values && !valuesError && (
              <span className="hint value-loading">
                <span className="spinner" /> Counting values…
              </span>
            )}
            {valuesError && <span className="hint">{valuesError}</span>}
            {shown.map(([v, n]) => (
              <label key={v} className="value-item">
                <input
                  type="checkbox"
                  checked={picked.has(v)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const next = new Set(p)
                      if (e.target.checked) next.add(v)
                      else next.delete(v)
                      return next
                    })
                  }
                />
                <span className="value-text">{v === '' ? <em>(empty)</em> : v}</span>
                {n > 0 && <span className="value-count">{formatCount(n)}</span>}
              </label>
            ))}
          </div>
          {values && <span className="hint">The {formatCount(values.length)} most common values in the shown rows.</span>}
        </div>
      )}
      <div className="popover-actions">
        {onRemove && (
          <button className="btn" onClick={onRemove}>
            Remove
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ready} onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  )
}
