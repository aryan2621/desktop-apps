import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
} from '@glideapps/glide-data-grid'
import { api, errorText, formatCount, type CellChange, type OpenedFile, type ViewState } from '../lib/api'
import { RowCache } from '../lib/rowCache'
import { useGridTheme } from '../lib/gridTheme'
import { ROW_HEIGHT, useSettings } from '../lib/settings'
import { Menu, type MenuEntry } from './Menu'
import { NamePrompt } from './NamePrompt'

export interface DataViewHandle {
  /** Selected view rows as [start, count] runs, highest first (safe to delete in order). */
  selectedRuns(): [number, number][]
  /** Row of the focused cell, if any. */
  currentRow(): number | undefined
  /** Column of the focused cell, if any. */
  currentCol(): number | undefined
  /** Drops cached rows and refetches what's visible (after structural edits or undo). */
  refresh(): void
  scrollToRow(row: number, col?: number): void
}

/** Selected block for status bar totals: display rows and view columns. */
export interface SelectionRange {
  start: number
  count: number
  cols: number[]
}

export interface HeaderActions {
  /** `then` adds the column as a further sort key instead of replacing the sort. */
  sort: (col: number, desc: boolean, then: boolean) => void
  clearSort: (col: number) => void
  filter: (col: number, at: { x: number; y: number }) => void
  stats: (col: number) => void
}

interface Props {
  file: OpenedFile
  view: ViewState
  /** Sorting and filtering are off while a pass runs. */
  busy: boolean
  actions: HeaderActions
  onView: (view: ViewState) => void
  onSelection: (range: SelectionRange | null) => void
  onError: (message: string) => void
}

/** Overscan around the visible region so small scrolls never show loading cells. */
const OVERSCAN = 100
/** Long values are cut for display only; the editor still gets the full text. */
const MAX_DISPLAY = 300
/** Same limit as the backend's one-operation cap. */
const MAX_CELLS = 100_000
/** Rows per backend read when copying. */
const COPY_CHUNK = 5000

const emptySelection: GridSelection = { rows: CompactSelection.empty(), columns: CompactSelection.empty() }

const defaultWidth = (name: string) => Math.min(320, Math.max(90, name.length * 8 + 40))

/** What a column mostly holds, judged from the first rows; drives alignment and the header icon. */
type ColumnType = 'number' | 'date' | 'text'
const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/
const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const isNumber = (v: string) => v !== '' && v !== '.' && v !== '-' && /\d/.test(v) && NUMBER.test(v)

function columnType(values: string[]): ColumnType {
  const filled = values.filter((v) => v !== '')
  if (filled.length === 0) return 'text'
  const share = (test: (v: string) => boolean) => filled.filter(test).length / filled.length
  if (share(isNumber) >= 0.9) return 'number'
  if (share((v) => DATE.test(v)) >= 0.9) return 'date'
  return 'text'
}

/** Rows sampled for auto-sizing and type detection: the first page, which loads first. */
const SAMPLE_ROWS = 200
/** Auto-sized columns stay within these bounds; dragging the edge can still go wider. */
const MIN_AUTO = 72
const MAX_AUTO = 360

let measureCtx: CanvasRenderingContext2D | null = null
/** Width of `text` in the grid's font, measured on a scratch canvas. */
function textWidth(text: string, font: string) {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7.5
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

/** CompactSelection keeps sorted [start, end) slices; reading them avoids expanding huge selections. */
const slices = (s: CompactSelection) => (s as unknown as { items: [number, number][] }).items

/** Small arrows and a funnel drawn in the header next to sorted / filtered column names. */
const headerIcons = {
  sortAsc: ({ fgColor }: { fgColor: string }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${fgColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15V5M6 9l4-4 4 4"/></svg>`,
  sortDesc: ({ fgColor }: { fgColor: string }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${fgColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5v10M6 11l4 4 4-4"/></svg>`,
  filter: ({ fgColor }: { fgColor: string }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${fgColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h12l-4.5 5.5V15l-3 1.5v-6z"/></svg>`,
  // Column types, shown when the column has no sort or filter.
  typeNumber: ({ fgColor }: { fgColor: string }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${fgColor}" stroke-width="1.6" stroke-linecap="round"><path d="M8 4L6.5 16M13.5 4L12 16M4.5 8h12M3.5 12h12"/></svg>`,
  typeText: ({ fgColor }: { fgColor: string }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${fgColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15l4-10 4 10M5.5 11.5h5M14 9.5a2 2 0 1 1 0 5.5 2 2 0 0 1 0-5.5zM16.2 9v6"/></svg>`,
  typeDate: ({ fgColor }: { fgColor: string }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${fgColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/></svg>`,
}
const TYPE_ICON: Record<ColumnType, string> = { number: 'typeNumber', text: 'typeText', date: 'typeDate' }

export const DataView = forwardRef<DataViewHandle, Props>(function DataView(
  { file, view, busy, actions, onView, onSelection, onError },
  ref,
) {
  const grid = useRef<DataEditorRef>(null)
  /** Re-reads the column sample; called by the row cache when the first page arrives. */
  const sampleRef = useRef<(() => void) | null>(null)
  const visible = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 })
  const { theme, rows: rowColors } = useGridTheme()
  const { density, rowStyle } = useSettings()
  const rowHeight = ROW_HEIGHT[density]
  /** Column types and content widths from the first rows; empty until they load. */
  const [sample, setSample] = useState<{ types: ColumnType[]; widths: number[] }>({ types: [], widths: [] })
  const [hoverRow, setHoverRow] = useState<number | undefined>()
  /** Columns pinned at the left while scrolling sideways. */
  const [frozen, setFrozen] = useState(0)
  const [selection, setSelection] = useState<GridSelection>(emptySelection)
  const [widths, setWidths] = useState<Record<string, number>>({})
  /** Open column header menu, or the name prompt for renaming / inserting a column. */
  const [headerMenu, setHeaderMenu] = useState<{ col: number; at: { x: number; y: number } } | null>(null)
  const [naming, setNaming] = useState<{ title: string; initial: string; at: { x: number; y: number }; submit: (name: string) => void } | null>(null)

  const cache = useMemo(
    () =>
      new RowCache(file.id, (first, count) => {
        if (first === 0) sampleRef.current?.()
        const v = visible.current
        if (first + count < v.y || first > v.y + v.height) return
        const cells: { cell: Item }[] = []
        for (let row = Math.max(first, v.y); row < Math.min(first + count, v.y + v.height + 1); row++) {
          for (let col = v.x; col < v.x + v.width; col++) cells.push({ cell: [col, row] })
        }
        grid.current?.updateCells(cells)
      }),
    [file.id],
  )

  const fontFamily = theme.fontFamily
  sampleRef.current = () => {
    const rows: string[][] = []
    for (let i = 0; i < SAMPLE_ROWS; i++) {
      const r = cache.get(i)
      if (!r) break
      rows.push(r)
    }
    if (rows.length === 0) return
    const cellFont = `13px ${fontFamily}`
    const headerFont = `600 12px ${fontFamily}`
    const types: ColumnType[] = []
    const widths: number[] = []
    view.columns.forEach((title, c) => {
      const values = rows.map((r) => r[c] ?? '')
      types.push(columnType(values))
      // The 95th percentile, so one huge value doesn't make the whole column wide.
      const lengths = values.map((v) => (v.length > 80 ? 9999 : textWidth(v, cellFont))).sort((a, b) => a - b)
      const body = lengths[Math.floor(lengths.length * 0.95)] ?? 0
      // Header text plus room for the type icon and the menu arrow.
      const header = textWidth(title, headerFont) + 56
      widths.push(Math.round(Math.min(MAX_AUTO, Math.max(MIN_AUTO, header, body + 24))))
    })
    setSample({ types, widths })
  }

  const ensureVisible = useCallback(() => {
    const v = visible.current
    cache.ensure(v.y - OVERSCAN, v.y + v.height + OVERSCAN)
  }, [cache])

  const refresh = useCallback(() => {
    cache.invalidate()
    ensureVisible()
  }, [cache, ensureVisible])

  // While indexing, the row count grows; fill in rows that just became readable.
  useEffect(() => {
    cache.dropPartial()
    ensureVisible()
  }, [view.rows, cache, ensureVisible])

  // Column changes (add, remove, rename, move) reshape every cached row.
  const columnsKey = view.columns.join('\u0000')
  useEffect(() => {
    refresh()
    sampleRef.current?.()
  }, [columnsKey, refresh])

  useImperativeHandle(
    ref,
    () => ({
      selectedRuns() {
        const rows = slices(selection.rows)
        if (rows.length > 0) return rows.map(([s, e]) => [s, e - s] as [number, number]).reverse()
        const range = selection.current?.range
        return range ? [[range.y, range.height]] : []
      },
      currentRow: () => selection.current?.cell[1],
      currentCol: () => selection.current?.cell[0],
      refresh,
      scrollToRow(row, col = 0) {
        grid.current?.scrollTo(col, row, 'both', 0, 0, { vAlign: 'center' })
        setSelection({
          ...emptySelection,
          current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
        })
      },
    }),
    [selection, refresh],
  )

  const columns = useMemo<GridColumn[]>(
    () =>
      view.columns.map((title, i) => {
        const key = view.view?.sort.find((k) => k.col === i)
        const filtered = view.view?.filters.some((f) => f.col === i)
        return {
          title,
          id: `${i}:${title}`,
          width: widths[title] ?? sample.widths[i] ?? defaultWidth(title),
          hasMenu: true,
          icon: key ? (key.desc ? 'sortDesc' : 'sortAsc') : filtered ? 'filter' : sample.types[i] && TYPE_ICON[sample.types[i]],
        }
      }),
    [view.columns, view.view, widths, sample],
  )

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const r = cache.get(row)
      if (!r) return { kind: GridCellKind.Loading, allowOverlay: false }
      const data = r[col] ?? ''
      return {
        kind: GridCellKind.Text,
        data,
        displayData: data.length > MAX_DISPLAY ? data.slice(0, MAX_DISPLAY) + '…' : data,
        // Numbers line up on the right, like in a spreadsheet.
        contentAlign: sample.types[col] === 'number' ? 'right' : undefined,
        allowOverlay: true,
        readonly: !view.editable,
      }
    },
    [cache, view.editable, sample.types],
  )

  /** Sends a batch of cell changes as one undo step. */
  const apply = useCallback(
    (changes: CellChange[]) => {
      if (changes.length === 0) return
      api
        .setCells(file.id, changes)
        .then((v) => {
          if (changes.length === 1) {
            const { row, col, value } = changes[0]
            cache.patch(row, col, value)
            grid.current?.updateCells([{ cell: [col, row] }])
          } else {
            refresh()
          }
          onView(v)
        })
        .catch((e) => onError(errorText(e)))
    },
    [file.id, cache, refresh, onView, onError],
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, value: EditableGridCell) => {
      if (value.kind === GridCellKind.Text) apply([{ row, col, value: value.data }])
    },
    [apply],
  )

  /** Delete key: clears every selected cell in one step. */
  const clear = useCallback(
    (sel: GridSelection) => {
      const width = view.columns.length
      const rects: Rectangle[] = []
      if (sel.current) rects.push(sel.current.range, ...sel.current.rangeStack)
      for (const [s, e] of slices(sel.rows)) rects.push({ x: 0, y: s, width, height: e - s })
      for (const [s, e] of slices(sel.columns)) rects.push({ x: s, y: 0, width: e - s, height: view.rows })
      const total = rects.reduce((n, r) => n + r.width * r.height, 0)
      if (total > MAX_CELLS) {
        onError(`That clears ${formatCount(total)} cells; one operation can change at most ${formatCount(MAX_CELLS)}.`)
        return
      }
      const changes: CellChange[] = []
      for (const r of rects)
        for (let row = r.y; row < r.y + r.height; row++)
          for (let col = r.x; col < r.x + r.width; col++) changes.push({ row, col, value: '' })
      apply(changes)
    },
    [view.columns.length, view.rows, apply, onError],
  )

  /** Paste from Excel, Sheets or text: the grid hands over parsed rows of cells. */
  const paste = useCallback(
    ([col, row]: Item, values: readonly (readonly string[])[]) => {
      if (!view.editable) return
      const rows = Math.min(values.length, view.rows - row)
      if (rows < values.length) {
        onError(`Only ${formatCount(rows)} of ${formatCount(values.length)} rows fit below this cell; insert rows first to paste the rest.`)
      }
      const changes: CellChange[] = []
      for (let r = 0; r < rows; r++)
        values[r].forEach((value, c) => {
          if (col + c < view.columns.length) changes.push({ row: row + r, col: col + c, value })
        })
      if (changes.length > MAX_CELLS) {
        onError(`That pastes ${formatCount(changes.length)} cells; one operation can change at most ${formatCount(MAX_CELLS)}.`)
        return
      }
      apply(changes)
    },
    [view.editable, view.rows, view.columns.length, apply, onError],
  )

  /** Copy reads rows from the backend, so it works beyond what's on screen. */
  const getCellsForSelection = useCallback(
    (rect: Rectangle) => {
      if (rect.width * rect.height > MAX_CELLS) {
        onError(`Copy is limited to ${formatCount(MAX_CELLS)} cells at a time.`)
        return []
      }
      return async () => {
        const out: GridCell[][] = []
        for (let y = rect.y; y < rect.y + rect.height; y += COPY_CHUNK) {
          const rows = await api.rows(file.id, y, Math.min(COPY_CHUNK, rect.y + rect.height - y))
          for (const r of rows) {
            const cells: GridCell[] = []
            for (let c = rect.x; c < rect.x + rect.width; c++) {
              const data = r[c] ?? ''
              cells.push({ kind: GridCellKind.Text, data, displayData: data, allowOverlay: false })
            }
            out.push(cells)
          }
        }
        return out
      }
    },
    [file.id, onError],
  )

  /** Column changes reshape every row, so the whole cache is refetched. */
  const editColumns = useCallback(
    (f: () => Promise<ViewState>) =>
      f()
        .then((v) => {
          setSelection(emptySelection)
          onView(v)
        })
        .catch((e) => onError(errorText(e))),
    [onView, onError],
  )

  const striped = rowStyle === 'striped'
  const getRowThemeOverride = useCallback(
    (row: number) =>
      row === hoverRow ? { bgCell: rowColors.hover } : striped && row % 2 === 1 ? { bgCell: rowColors.stripe } : undefined,
    [hoverRow, striped, rowColors],
  )

  // Stable, so the popovers don't re-run their mount effects (focus, select) on every grid render.
  const closeHeaderMenu = useCallback(() => setHeaderMenu(null), [])
  const closeNaming = useCallback(() => setNaming(null), [])

  const openHeaderMenu = useCallback((col: number, x: number, y: number) => setHeaderMenu({ col, at: { x, y } }), [])

  // Status bar totals follow the selected block (whole rows or columns count too).
  useEffect(() => {
    const all = view.columns.map((_, i) => i)
    const cols = slices(selection.columns).flatMap(([s, e]) => all.slice(s, e))
    const rows = slices(selection.rows)
    const range = selection.current?.range
    if (cols.length > 0) onSelection({ start: 0, count: view.rows, cols })
    else if (rows.length === 1) onSelection({ start: rows[0][0], count: rows[0][1] - rows[0][0], cols: all })
    else if (range && range.width * range.height > 1)
      onSelection({ start: range.y, count: range.height, cols: all.slice(range.x, range.x + range.width) })
    else onSelection(null)
  }, [selection, view.columns, view.rows, onSelection])

  const headerEntries = (col: number, at: { x: number; y: number }): MenuEntry[] => {
    // Deletes every selected column when the clicked one is part of the selection.
    const selected = selection.columns.hasIndex(col) ? selection.columns.toArray() : [col]
    const insert = (offset: number) => () =>
      setNaming({
        title: 'New column name',
        initial: `Column ${view.columns.length + 1}`,
        at,
        submit: (name) => editColumns(() => api.insertColumn(file.id, col + offset, name)),
      })
    const freezing: MenuEntry[] =
      frozen > 0 && col < frozen
        ? [{ label: 'Unfreeze columns', onSelect: () => setFrozen(0) }]
        : [
            {
              label: col === 0 ? 'Freeze first column' : `Freeze columns up to here (${col + 1})`,
              onSelect: () => setFrozen(col + 1),
            },
          ]
    const fit: MenuEntry = {
      label: 'Fit width to contents',
      onSelect: () =>
        setWidths((w) => {
          const next = { ...w }
          delete next[view.columns[col]]
          return next
        }),
    }
    const sortKey = view.view?.sort.find((k) => k.col === col)
    const otherSort = (view.view?.sort ?? []).some((k) => k.col !== col)
    const ordering = !view.loading && !busy
    const sorting: MenuEntry[] = [
      { label: 'Sort A → Z, 0 → 9', disabled: !ordering, onSelect: () => actions.sort(col, false, false) },
      { label: 'Sort Z → A, 9 → 0', disabled: !ordering, onSelect: () => actions.sort(col, true, false) },
      ...(otherSort
        ? [
            { label: 'Then by this, ascending', disabled: !ordering, onSelect: () => actions.sort(col, false, true) },
            { label: 'Then by this, descending', disabled: !ordering, onSelect: () => actions.sort(col, true, true) },
          ]
        : []),
      ...(sortKey ? [{ label: 'Remove this sort', disabled: !ordering, onSelect: () => actions.clearSort(col) }] : []),
      'separator',
      { label: 'Filter…', disabled: !ordering, onSelect: () => actions.filter(col, at) },
      { label: 'Column statistics', disabled: view.loading, onSelect: () => actions.stats(col) },
      'separator',
      ...freezing,
      fit,
    ]
    if (view.view) {
      return [...sorting, 'separator', { label: 'Clear sort and filter to change columns', disabled: true, onSelect: () => {} }]
    }
    if (!view.columnEdits) return sorting
    return [
      ...sorting,
      'separator',
      {
        label: 'Rename column…',
        onSelect: () =>
          setNaming({
            title: 'Rename column',
            initial: view.columns[col] ?? '',
            at,
            submit: (name) => editColumns(() => api.renameColumn(file.id, col, name)),
          }),
      },
      'separator',
      { label: 'Insert column left…', onSelect: insert(0) },
      { label: 'Insert column right…', onSelect: insert(1) },
      'separator',
      {
        label: selected.length > 1 ? `Delete ${selected.length} columns` : 'Delete column',
        disabled: selected.length >= view.columns.length,
        onSelect: () => editColumns(() => api.deleteColumns(file.id, selected)),
      },
    ]
  }

  return (
    <div className="grid-wrap">
      <DataEditor
        ref={grid}
        theme={theme}
        columns={columns}
        rows={view.rows}
        getCellContent={getCellContent}
        getCellsForSelection={getCellsForSelection}
        onCellEdited={onCellEdited}
        onDelete={(sel) => {
          clear(sel)
          return false
        }}
        onPaste={(target, values) => {
          paste(target, values)
          return false
        }}
        onVisibleRegionChanged={(r) => {
          visible.current = r
          ensureVisible()
        }}
        onColumnResize={(col, width) => setWidths((w) => ({ ...w, [col.title]: width }))}
        onHeaderMenuClick={(col, b) => openHeaderMenu(col, b.x, b.y + b.height)}
        onHeaderContextMenu={(col, e) => {
          e.preventDefault()
          openHeaderMenu(col, e.bounds.x + e.localEventX, e.bounds.y + e.localEventY)
        }}
        headerIcons={headerIcons}
        onColumnMoved={
          view.columnEdits ? (from, to) => from !== to && editColumns(() => api.moveColumn(file.id, from, to)) : undefined
        }
        gridSelection={selection}
        onGridSelectionChange={setSelection}
        freezeColumns={Math.min(frozen, view.columns.length)}
        onItemHovered={(args) => setHoverRow(args.kind === 'cell' ? args.location[1] : undefined)}
        getRowThemeOverride={getRowThemeOverride}
        rowMarkers={{ kind: 'both', width: Math.max(56, String(view.rows).length * 8 + 28) }}
        smoothScrollX
        smoothScrollY
        rowHeight={rowHeight}
        headerHeight={34}
        width="100%"
        height="100%"
      />
      {headerMenu && (
        <Menu entries={headerEntries(headerMenu.col, headerMenu.at)} at={headerMenu.at} onClose={closeHeaderMenu} />
      )}
      {naming && (
        <NamePrompt
          title={naming.title}
          initial={naming.initial}
          at={naming.at}
          onSubmit={(name) => {
            setNaming(null)
            naming.submit(name)
          }}
          onClose={closeNaming}
        />
      )}
    </div>
  )
})
