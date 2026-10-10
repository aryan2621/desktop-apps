import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { api, errorText, formatCount, type SearchProgress, type ViewState } from '../lib/api'
import { Dropdown } from './Dropdown'
import { IconChevronDown, IconChevronUp, IconClose } from './Icons'

interface Props {
  id: number
  columns: string[]
  /** Changes whenever the data changes, so results are refreshed. */
  dataVersion: number
  /** Increments when ⌘F is pressed again: refocus and select the text. */
  focusSignal: number
  editable: boolean
  /** Row the user is on, so the first jump goes to the nearest match below it. */
  currentRow: () => number
  onJump: (row: number, col: number | null) => void
  onView: (view: ViewState) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
  onClose: () => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'searching'; percent: number }
  | { kind: 'done'; count: number; index: number | null }

/** Find (and replace) across the whole file, in the agentic-browser find-bar style. */
export function FindBar(p: Props) {
  const { id, columns, dataVersion, focusSignal, editable, currentRow, onJump, onView, onError, onNotice, onClose } = p
  const [text, setText] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [regex, setRegex] = useState(false)
  const [column, setColumn] = useState('all')
  const [replacing, setReplacing] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const searchId = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusSignal])

  const seek = useCallback(
    async (args: { index?: number; row?: number; forward: boolean }) => {
      try {
        const hit = await api.searchSeek(id, args)
        if (!hit) return
        setStatus((s) => (s.kind === 'done' ? { ...s, index: hit.index } : s))
        onJump(hit.row, hit.col)
      } catch (e) {
        onError(errorText(e))
      }
    },
    [id, onJump, onError],
  )

  // Progress and results for the search this bar started.
  useEffect(() => {
    const off = listen<SearchProgress>('search-progress', ({ payload: e }) => {
      if (e.id !== id || e.searchId !== searchId.current) return
      if (!e.done) {
        setStatus({ kind: 'searching', percent: Math.round((100 * e.scanned) / Math.max(1, e.total)) })
        return
      }
      setStatus({ kind: 'done', count: e.count ?? 0, index: null })
      if (e.count) seek({ row: currentRow(), forward: true })
    })
    return () => {
      off.then((f) => f())
    }
  }, [id, seek, currentRow])

  // (Re)start the search when the query or the data changes.
  useEffect(() => {
    if (!text) {
      setStatus({ kind: 'idle' })
      api.searchStop(id).catch(() => {})
      return
    }
    const timer = setTimeout(() => {
      const query = { text, matchCase, regex, column: column === 'all' ? null : Number(column) }
      setStatus({ kind: 'searching', percent: 0 })
      api
        .searchStart(id, query)
        .then((sid) => (searchId.current = sid))
        .catch((e) => {
          setStatus({ kind: 'idle' })
          onError(errorText(e))
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [id, text, matchCase, regex, column, dataVersion, onError])

  const count = status.kind === 'done' ? status.count : 0
  const step = (forward: boolean) => {
    if (status.kind !== 'done' || !count) return
    const index = status.index === null ? undefined : status.index + (forward ? 1 : -1)
    seek(index === undefined ? { row: currentRow(), forward } : { index, forward })
  }

  const replace = async (all: boolean) => {
    if (status.kind !== 'done' || !count) return
    try {
      let rows: number[] | undefined
      if (!all) {
        const hit = await api.searchSeek(id, { index: status.index ?? 0, forward: true })
        if (!hit) return
        rows = [hit.row]
      }
      const result = await api.searchReplace(id, rows, replacement)
      onView(result.view)
      if (all) onNotice(`Replaced ${formatCount(result.cells)} cell${result.cells === 1 ? '' : 's'}.`)
    } catch (e) {
      onError(errorText(e))
    }
  }

  const close = () => {
    api.searchStop(id).catch(() => {})
    onClose()
  }

  const label =
    status.kind === 'searching'
      ? `Searching… ${status.percent}%`
      : status.kind === 'done' && text
        ? count
          ? status.index === null
            ? `${formatCount(count)} matches`
            : `${formatCount(status.index + 1)} of ${formatCount(count)}`
          : 'No matches'
        : ''

  const columnOptions = [
    { value: 'all', label: 'All columns' },
    ...columns.map((name, i) => ({ value: String(i), label: name })),
  ]

  return (
    <div className="find-wrap">
      <div className="find-bar" role="search" aria-label="Find in file">
        <button
          className={`icon-btn find-toggle${replacing ? ' open' : ''}`}
          aria-label={replacing ? 'Hide replace' : 'Show replace'}
          title="Replace"
          aria-expanded={replacing}
          disabled={!editable}
          onClick={() => setReplacing((r) => !r)}
        >
          <IconChevronDown />
        </button>
        <input
          ref={input}
          aria-label="Find in file"
          placeholder="Find in file"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(!e.shiftKey)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <span className="find-count" role="status" aria-live="polite">
          {label}
        </span>
        <button className="icon-btn" aria-label="Previous match" title="Previous (⇧Enter)" disabled={!count} onClick={() => step(false)}>
          <IconChevronUp />
        </button>
        <button className="icon-btn" aria-label="Next match" title="Next (Enter)" disabled={!count} onClick={() => step(true)}>
          <IconChevronDown />
        </button>
        <span className="toolbar-sep" />
        <button
          className={`chip${matchCase ? ' active' : ''}`}
          aria-pressed={matchCase}
          onClick={() => setMatchCase((v) => !v)}
        >
          Match case
        </button>
        <button className={`chip${regex ? ' active' : ''}`} aria-pressed={regex} onClick={() => setRegex((v) => !v)}>
          Regex
        </button>
        <Dropdown
          value={column}
          options={columnOptions}
          onChange={setColumn}
          ariaLabel="Search in column"
          align="right"
          className="find-column"
        />
        <button className="icon-btn" aria-label="Close find bar" title="Close (Esc)" onClick={close}>
          <IconClose />
        </button>
      </div>
      {replacing && editable && (
        <div className="find-bar">
          <input
            aria-label="Replace with"
            placeholder={regex ? 'Replace with ($1 for groups)' : 'Replace with'}
            value={replacement}
            spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                replace(e.metaKey || e.ctrlKey)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
          />
          <button className="btn" disabled={!count} onClick={() => replace(false)}>
            Replace
          </button>
          <button className="btn" disabled={!count} onClick={() => replace(true)} title="Replace all (⌘Enter)">
            Replace all
          </button>
        </div>
      )}
    </div>
  )
}
