import { api } from './api'

const PAGE = 256
const MAX_PAGES = 80

/**
 * Pages of rows fetched on demand from the backend. Only what the grid shows
 * (plus a little LRU slack) is ever held in the webview.
 */
export class RowCache {
  private pages = new Map<number, string[][]>()
  private pending = new Set<number>()
  /** Bumped on invalidate so responses for stale data are dropped. */
  private generation = 0

  constructor(
    private id: number,
    private onLoaded: (firstRow: number, count: number) => void,
  ) {}

  get(row: number): string[] | undefined {
    const page = this.pages.get(Math.floor(row / PAGE))
    return page?.[row % PAGE]
  }

  /** Patches a cached cell after a successful edit, without a refetch. */
  patch(row: number, col: number, value: string) {
    const r = this.get(row)
    if (!r) return
    while (r.length <= col) r.push('')
    r[col] = value
  }

  /** Fetches any missing pages covering rows `from..to`. */
  ensure(from: number, to: number) {
    const first = Math.floor(Math.max(0, from) / PAGE)
    const last = Math.floor(Math.max(0, to) / PAGE)
    for (let p = first; p <= last; p++) {
      if (this.pages.has(p)) {
        // Refresh LRU order.
        const page = this.pages.get(p)!
        this.pages.delete(p)
        this.pages.set(p, page)
      } else if (!this.pending.has(p)) {
        this.load(p)
      }
    }
  }

  invalidate() {
    this.pages.clear()
    this.pending.clear()
    this.generation++
  }

  /** Drops partially filled pages so rows that arrived since are fetched. */
  dropPartial() {
    for (const [p, rows] of this.pages) if (rows.length < PAGE) this.pages.delete(p)
  }

  private async load(p: number) {
    const gen = this.generation
    this.pending.add(p)
    try {
      const rows = await api.rows(this.id, p * PAGE, PAGE)
      if (gen !== this.generation) return
      this.pages.set(p, rows)
      while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value!)
      this.onLoaded(p * PAGE, rows.length)
    } finally {
      if (gen === this.generation) this.pending.delete(p)
    }
  }
}
