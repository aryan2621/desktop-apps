import { useEffect, useState } from 'react'
import { api, CANCELLED, errorText, formatCount, formatNumber, type ColumnStats } from '../lib/api'
import { IconClose } from './Icons'

interface Props {
  id: number
  col: number
  column: string
  /** Changes when the data or the filter changes; the panel offers a refresh. */
  dataVersion: number
  filtered: boolean
  onFilterValue: (value: string) => void
  onClose: () => void
}

/** Side panel with one column's statistics over the shown rows. */
export function StatsPanel({ id, col, column, dataVersion, filtered, onFilterValue, onClose }: Props) {
  const [stats, setStats] = useState<ColumnStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(dataVersion)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let live = true
    setStats(null)
    setError(null)
    const version = dataVersion
    api
      .columnStats(id, col)
      .then((s) => {
        if (!live) return
        setStats(s)
        setLoadedAt(version)
      })
      .catch((e) => live && setError(errorText(e) === CANCELLED ? 'Cancelled.' : errorText(e)))
    return () => {
      live = false
    }
    // dataVersion is read, not watched: the user refreshes when they want to.
  }, [id, col, reload])

  const top = stats?.top[0]?.[1] ?? 1
  const rows: [string, string][] = stats
    ? [
        ['Rows', formatCount(stats.rows)],
        ['Empty', formatCount(stats.empty)],
        ['Distinct', `${formatCount(stats.distinct)}${stats.distinctCapped ? '+' : ''}`],
        ...(stats.numeric
          ? ([
              ['Numbers', formatCount(stats.numbers)],
              ['Min', stats.min ?? '–'],
              ['Max', stats.max ?? '–'],
              ['Sum', stats.sum === null ? '–' : formatNumber(stats.sum)],
              ['Average', stats.avg === null ? '–' : formatNumber(stats.avg)],
            ] as [string, string][])
          : ([
              ['First (A–Z)', stats.min ?? '–'],
              ['Last (A–Z)', stats.max ?? '–'],
            ] as [string, string][])),
      ]
    : []

  return (
    <aside className="stats-panel" aria-label={`Statistics for ${column}`}>
      <div className="stats-head">
        <span className="stats-title" title={column}>
          {column}
        </span>
        <button className="tab-close" aria-label="Close statistics" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      {filtered && <span className="hint">Over the filtered rows</span>}
      {!stats && !error && (
        <span className="hint stats-loading">
          <span className="spinner" /> Reading every row…
        </span>
      )}
      {error && <span className="hint">{error}</span>}
      {stats && (
        <>
          {loadedAt !== dataVersion && (
            <button className="btn small" onClick={() => setReload((n) => n + 1)}>
              Data changed – refresh
            </button>
          )}
          <dl className="stats-list">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd title={v}>{v}</dd>
              </div>
            ))}
          </dl>
          <span className="stats-sub">
            Most common{stats.distinctCapped ? ' (approximate)' : ''}
          </span>
          <ul className="stats-top">
            {stats.top.map(([v, n]) => (
              <li key={v}>
                <button title={`Show only rows where ${column} is this value`} onClick={() => onFilterValue(v)}>
                  <i style={{ width: `${(100 * n) / top}%` }} />
                  <span className="value-text">{v === '' ? <em>(empty)</em> : v}</span>
                  <span className="value-count">{formatCount(n)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
