import { useEffect, useRef, useState } from 'react'
import { formatCount } from '../lib/api'
import { IconClose } from './Icons'

interface Props {
  rows: number
  onGo: (row: number) => void
  onClose: () => void
}

/** "Go to row" strip under the toolbar, in the find-bar style. Rows are 1-based for people. */
export function GoToRow({ rows, onGo, onClose }: Props) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const n = Number(text.replace(/[,\s_]/g, ''))
  const valid = Number.isInteger(n) && n >= 1 && n <= rows

  const go = () => {
    if (valid) onGo(n - 1)
  }

  return (
    <div className="find-bar" role="search" aria-label="Go to row">
      <span className="hint">Go to row</span>
      <input
        ref={input}
        inputMode="numeric"
        aria-label="Row number"
        placeholder={`1 – ${formatCount(rows)}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            go()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <button className="btn" disabled={!valid} onClick={go}>
        Go
      </button>
      <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
        <IconClose />
      </button>
    </div>
  )
}
