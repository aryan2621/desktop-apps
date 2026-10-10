import { describeFilter, formatCount, type ViewSpec } from '../lib/api'
import { IconClose } from './Icons'

interface Props {
  spec: ViewSpec
  columns: string[]
  rows: number
  baseRows: number
  stale: boolean
  busy: boolean
  onRemoveSort: (index: number) => void
  onEditFilter: (index: number, at: { x: number; y: number }) => void
  onRemoveFilter: (index: number) => void
  onReapply: () => void
  onClearAll: () => void
  /** Saves just these rows to a new file (absent while saving is locked). */
  onExport?: () => void
}

/** Active sort and filters as removable chips under the toolbar. */
export function FilterBar(p: Props) {
  const name = (col: number) => p.columns[col] ?? `Column ${col + 1}`
  return (
    <div className="filter-bar" role="toolbar" aria-label="Sort and filters">
      {p.spec.sort.map((k, i) => (
        <span key={`s${i}`} className="chip active filter-chip">
          {i === 0 ? 'Sorted by' : 'then'} {name(k.col)} {k.desc ? '↓' : '↑'}
          <button aria-label={`Remove sort by ${name(k.col)}`} disabled={p.busy} onClick={() => p.onRemoveSort(i)}>
            <IconClose />
          </button>
        </span>
      ))}
      {p.spec.filters.map((f, i) => (
        <span key={`f${i}`} className="chip active filter-chip">
          <button
            className="filter-chip-label"
            title="Edit filter"
            disabled={p.busy}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              p.onEditFilter(i, { x: r.left, y: r.bottom + 6 })
            }}
          >
            {describeFilter(f, p.columns)}
          </button>
          <button aria-label="Remove filter" disabled={p.busy} onClick={() => p.onRemoveFilter(i)}>
            <IconClose />
          </button>
        </span>
      ))}
      {p.spec.filters.length > 0 && (
        <span className="hint">
          {formatCount(p.rows)} of {formatCount(p.baseRows)} rows
        </span>
      )}
      <span className="grow" />
      {p.stale && (
        <button className="btn small" disabled={p.busy} title="Edited values stay where they are until you re-apply" onClick={p.onReapply}>
          Re-apply
        </button>
      )}
      <button
        className="btn small"
        disabled={p.busy || !p.onExport}
        title="Save these rows, in this order, to a new file"
        // Keeps the export popover's outside-click handler from closing it as it opens.
        onMouseDown={(e) => e.nativeEvent.stopPropagation()}
        onClick={p.onExport}
      >
        Export…
      </button>
      <button className="btn small" disabled={p.busy} onClick={p.onClearAll}>
        Clear all
      </button>
    </div>
  )
}
