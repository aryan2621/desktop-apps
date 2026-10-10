import { useEffect, useRef, useState } from 'react'
import { EXCEL_SHEET_ROWS, formatCount, type ExportFormat } from '../lib/api'

export const EXPORT_FORMATS: { value: ExportFormat; label: string; ext: string[] }[] = [
  { value: 'csv', label: 'CSV', ext: ['csv', 'txt'] },
  { value: 'tsv', label: 'TSV', ext: ['tsv'] },
  { value: 'json', label: 'JSON', ext: ['json'] },
  { value: 'jsonLines', label: 'JSON Lines', ext: ['jsonl', 'ndjson'] },
  { value: 'xlsx', label: 'Excel', ext: ['xlsx'] },
]

/** The format a chosen path's extension asks for (`fallback` when it names none). */
export function formatFromPath(path: string, fallback: ExportFormat): ExportFormat {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'txt' && (fallback === 'csv' || fallback === 'tsv')) return fallback
  return EXPORT_FORMATS.find((f) => f.ext.includes(ext))?.value ?? fallback
}

interface Props {
  /** Export just the sorted / filtered rows. */
  viewOnly: boolean
  /** The file's own format (saving in it keeps the file's layout). */
  native: ExportFormat
  rows: number
  columns: number
  at: { x: number; y: number }
  /** Picks the location next, in the system save dialog. */
  onChoose: (format: ExportFormat) => void
  onClose: () => void
}

function describe(format: ExportFormat, native: ExportFormat, viewOnly: boolean, rows: number): string {
  if (format === native && !viewOnly) {
    return format === 'xlsx'
      ? 'Keeps every sheet and cell type; formatting, formulas, charts and macros are dropped.'
      : 'Keeps the file as it is, apart from your edits.'
  }
  const fromJson = native === 'json' || native === 'jsonLines'
  switch (format) {
    case 'xlsx': {
      const sheets = Math.ceil(rows / EXCEL_SHEET_ROWS)
      const split =
        sheets > 1
          ? ` Excel holds ${formatCount(EXCEL_SHEET_ROWS)} rows per sheet, so this is split across ${sheets} sheets.`
          : ''
      return `Values and their types, on a sheet with a header row.${fromJson ? ' Nested values are written as JSON text.' : ''}${split}`
    }
    case 'json':
    case 'jsonLines':
      return fromJson
        ? 'One object per row, keyed by column name. Values keep their JSON types.'
        : 'One object per row, keyed by column name. Numbers and true/false become JSON values; empty cells become null.'
    default:
      return fromJson
        ? 'Nested objects and arrays are written as JSON text; null becomes an empty cell.'
        : `UTF-8 with a header row, ${format === 'tsv' ? 'tab' : 'comma'} separated.`
  }
}

/** Save as / Export current view: pick a format, then a location. */
export function SaveAs({ viewOnly, native, rows, columns, at, onChoose, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>(native)
  const root = useRef<HTMLDivElement>(null)
  const choose = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    choose.current?.focus()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const title = viewOnly ? 'Export current view' : 'Save as'
  return (
    <div
      ref={root}
      className="popover save-as"
      role="dialog"
      aria-label={title}
      style={{ top: at.y, left: Math.max(8, Math.min(at.x, window.innerWidth - 368)) }}
    >
      <span className="popover-title">{title}</span>
      <span className="hint">
        {formatCount(rows)} {viewOnly ? 'sorted and filtered ' : ''}rows · {formatCount(columns)} columns
      </span>
      <div className="chips" role="radiogroup" aria-label="Format">
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f.value}
            role="radio"
            aria-checked={format === f.value}
            className={`chip${format === f.value ? ' active' : ''}`}
            onClick={() => setFormat(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <span className="hint">{describe(format, native, viewOnly, rows)}</span>
      <div className="popover-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button ref={choose} className="btn primary" onClick={() => onChoose(format)}>
          Choose location…
        </button>
      </div>
    </div>
  )
}
