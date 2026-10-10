import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, formatBytes, type FileInfo } from '../lib/api'
import { clearRecent, removeRecent, removeRecentMany } from '../lib/settings'
import { IconBraces, IconClose, IconCsv, IconFolder, IconSheet, IconTrash } from './Icons'

export type FileKind = 'xlsx' | 'csv' | 'json'

interface Props {
  recent: string[]
  opening: boolean
  dragging: boolean
  /** Opens the system picker, limited to one kind of file, or every data file. */
  onPick: (kind?: FileKind) => void
  onOpen: (path: string) => void
}

const OPENERS: {
  kind: FileKind
  title: string
  ext: string
  icon: ReactNode
}[] = [
  {
    kind: 'xlsx',
    title: 'Excel',
    ext: '.xlsx  .xlsm',
    icon: <IconSheet size={20} />,
  },
  {
    kind: 'csv',
    title: 'CSV',
    ext: '.csv  .tsv  .txt',
    icon: <IconCsv size={20} />,
  },
  {
    kind: 'json',
    title: 'JSON and others',
    ext: '.json  .jsonl  .ndjson',
    icon: <IconBraces size={20} />,
  },
]

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path
const extOf = (path: string) => baseName(path).split('.').pop()?.toLowerCase() ?? ''

function kindOf(path: string): FileKind {
  const ext = extOf(path)
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx'
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'json'
  return 'csv'
}

/** "just now", "5 min ago", "yesterday", "3 days ago", then the date. */
function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

const KIND_ICON: Record<FileKind, ReactNode> = {
  xlsx: <IconSheet />,
  csv: <IconCsv />,
  json: <IconBraces />,
}

/** Start page: openers per file type on the left, recent files (removable one by one or in bulk) on the right. */
export function StartPage({ recent, opening, dragging, onPick, onOpen }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Size and modified time per path; null marks a file that is gone. */
  const [info, setInfo] = useState<Map<string, FileInfo | null>>(new Map())

  useEffect(() => {
    let live = true
    api
      .fileInfo(recent)
      .then((list) => live && setInfo(new Map(recent.map((p, i) => [p, list[i] ?? null]))))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [recent])
  // Paths that dropped out of the list (opened elsewhere, cleared) are no longer selectable.
  const picked = useMemo(() => recent.filter((p) => selected.has(p)), [recent, selected])
  /** Recent files that were moved or deleted. */
  const gone = recent.filter((p) => info.get(p) === null)
  const allPicked = recent.length > 0 && picked.length === recent.length

  const toggle = (path: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className={`start${dragging ? ' dragging' : ''}`}>
      <section className="start-col start-open" aria-labelledby="start-open-title">
        <h1 className="start-title" id="start-open-title">
          Open a large file
        </h1>
        <p className="hint">Files of any size open in seconds. Drop files anywhere in this window, or pick a type.</p>
        <div className="start-openers">
          {OPENERS.map((o) => (
            <button key={o.kind} className={`opener opener-${o.kind}`} disabled={opening} onClick={() => onPick(o.kind)}>
              <span className="opener-icon">{o.icon}</span>
              <span className="opener-text">
                <span className="opener-title">{o.title}</span>
                <span className="opener-ext">{o.ext}</span>
              </span>
            </button>
          ))}
        </div>
        <button className="btn primary" onClick={() => onPick()} disabled={opening}>
          {opening ? <span className="spinner" /> : <IconFolder />}
          Open any file…
        </button>
      </section>

      <section className="start-col start-recent-col" aria-labelledby="start-recent-title">
        <header className="recent-head">
          <h2 id="start-recent-title">Recent files</h2>
          {recent.length > 0 && <span className="hint">{recent.length}</span>}
        </header>
        {recent.length === 0 ? (
          <div className="recent-empty hint">Files you open show up here.</div>
        ) : (
          <>
            <div className="recent-toolbar">
              <label className="recent-check">
                <input
                  type="checkbox"
                  checked={allPicked}
                  ref={(el) => {
                    if (el) el.indeterminate = picked.length > 0 && !allPicked
                  }}
                  onChange={() => setSelected(allPicked ? new Set() : new Set(recent))}
                />
                {picked.length > 0 ? `${picked.length} selected` : 'Select all'}
              </label>
              <span className="grow" />
              {picked.length > 0 ? (
                <button
                  className="btn small danger"
                  title="Removes them from this list; the files stay on disk"
                  onClick={() => {
                    removeRecentMany(picked)
                    setSelected(new Set())
                  }}
                >
                  <IconTrash /> Remove {picked.length}
                </button>
              ) : (
                <>
                  {gone.length > 0 && (
                    <button className="btn small subtle" title="Removes files that were moved or deleted" onClick={() => removeRecentMany(gone)}>
                      Remove missing ({gone.length})
                    </button>
                  )}
                  <button className="btn small subtle" title="Empties this list; the files stay on disk" onClick={clearRecent}>
                    Clear all
                  </button>
                </>
              )}
            </div>
            <ul className="recent-list">
              {recent.map((path) => {
                const meta = info.get(path)
                const missing = meta === null
                return (
                  <li key={path} className={`${selected.has(path) ? 'selected' : ''}${missing ? ' missing' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${baseName(path)}`}
                      checked={selected.has(path)}
                      onChange={() => toggle(path)}
                    />
                    <button
                      className="recent-open"
                      disabled={missing}
                      onClick={() => onOpen(path)}
                      title={missing ? `${path} was moved or deleted` : `Open ${path}`}
                    >
                      <span className={`recent-icon kind-${kindOf(path)}`}>{KIND_ICON[kindOf(path)]}</span>
                      <span className="recent-text">
                        <span className="start-recent-name">{baseName(path)}</span>
                        <span className="start-recent-path">{path}</span>
                      </span>
                      {meta !== undefined && (
                        <span className="recent-meta">
                          {missing ? (
                            'File not found'
                          ) : (
                            <>
                              <span>{formatBytes(meta.size)}</span>
                              {meta.modifiedMs !== null && <span>{ago(meta.modifiedMs)}</span>}
                            </>
                          )}
                        </span>
                      )}
                    </button>
                    <button
                      className="tab-close recent-remove"
                      aria-label={`Remove ${baseName(path)} from recent files`}
                      title="Remove from list"
                      onClick={() => removeRecent(path)}
                    >
                      <IconClose />
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </section>
      {dragging && <div className="drop-overlay">Drop to open</div>}
    </div>
  )
}
