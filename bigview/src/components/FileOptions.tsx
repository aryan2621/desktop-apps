import { useEffect, useRef } from 'react'
import type { OpenOptions } from '../lib/api'
import { Dropdown } from './Dropdown'

const DELIMITERS = [
  { value: ',', label: 'Comma ( , )' },
  { value: ';', label: 'Semicolon ( ; )' },
  { value: '\\t', label: 'Tab' },
  { value: '|', label: 'Pipe ( | )' },
]

const ENCODINGS: { value: string; label: string; description?: string }[] = [
  { value: 'UTF-8', label: 'UTF-8', description: 'Most files today' },
  { value: 'UTF-16LE', label: 'UTF-16 LE', description: 'Excel "Unicode text" exports' },
  { value: 'UTF-16BE', label: 'UTF-16 BE' },
  { value: 'windows-1252', label: 'Western (Windows-1252)', description: 'Older Excel CSVs from Windows' },
  { value: 'windows-1251', label: 'Cyrillic (Windows-1251)' },
  { value: 'windows-1250', label: 'Central European (Windows-1250)' },
  { value: 'ISO-8859-2', label: 'Central European (ISO-8859-2)' },
  { value: 'Shift_JIS', label: 'Japanese (Shift_JIS)' },
  { value: 'GBK', label: 'Chinese Simplified (GBK)' },
  { value: 'Big5', label: 'Chinese Traditional (Big5)' },
  { value: 'EUC-KR', label: 'Korean (EUC-KR)' },
]

interface Props {
  format: string
  options: OpenOptions
  at: { x: number; y: number }
  /** Reopens the file with these options. */
  onChange: (options: OpenOptions) => void
  onClose: () => void
}

/** How the file is read: header row, delimiter and encoding. Changing one reopens the file. */
export function FileOptions({ format, options, at, onChange, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // Dropdown menus render inside the popover, so this only fires for outside clicks.
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const encodings = format === 'json' ? ENCODINGS.filter((e) => e.value.startsWith('UTF')) : ENCODINGS

  return (
    <div ref={root} className="popover file-options" role="dialog" aria-label="File options" style={{ top: at.y, right: Math.max(8, window.innerWidth - at.x) }}>
      <span className="popover-title">How this file is read</span>
      {format !== 'json' && (
        <label className="option-row">
          <span>
            First row is the header
            <span className="hint">Column names come from the first row</span>
          </span>
          <input
            type="checkbox"
            checked={options.hasHeader ?? true}
            onChange={(e) => onChange({ ...options, hasHeader: e.target.checked })}
          />
        </label>
      )}
      {format === 'csv' && (
        <div className="option-row">
          <span>Delimiter</span>
          <Dropdown
            value={options.delimiter ?? ','}
            options={DELIMITERS}
            onChange={(delimiter) => onChange({ ...options, delimiter })}
            ariaLabel="Delimiter"
            align="right"
          />
        </div>
      )}
      {format !== 'xlsx' && (
        <div className="option-row">
          <span>Encoding</span>
          <Dropdown
            value={encodings.some((e) => e.value === options.encoding) ? options.encoding! : 'UTF-8'}
            options={encodings}
            onChange={(encoding) => onChange({ ...options, encoding })}
            ariaLabel="Encoding"
            align="right"
          />
        </div>
      )}
      <span className="hint">Changing an option reopens the file.</span>
    </div>
  )
}
