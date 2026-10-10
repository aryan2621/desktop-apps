import { invoke } from '@tauri-apps/api/core'

export interface ViewState {
  /** Rows shown (after filtering). */
  rows: number
  /** Rows of the file before filtering. */
  baseRows: number
  /** Still indexing: rows keep arriving. */
  loading: boolean
  /** Cells can be edited (also while the file is still loading). */
  editable: boolean
  /** Rows can be inserted or deleted. */
  structural: boolean
  columnEdits: boolean
  savable: boolean
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
  columns: string[]
  /** Active sort and filters. */
  view: ViewSpec | null
  /** Cells changed since the sort or filter ran; rows move on re-apply. */
  viewStale: boolean
}

export interface SortKey {
  col: number
  desc: boolean
}

export type FilterKind =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'startsWith'
  | 'regex'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'lt'
  | 'between'
  | 'empty'
  | 'notEmpty'
  | 'oneOf'

export interface Filter {
  col: number
  kind: FilterKind
  value: string
  value2: string
  values: string[]
  matchCase: boolean
}

export interface ViewSpec {
  sort: SortKey[]
  filters: Filter[]
}

export interface ColumnStats {
  rows: number
  empty: number
  distinct: number
  distinctCapped: boolean
  numeric: boolean
  numbers: number
  min: string | null
  max: string | null
  sum: number | null
  avg: number | null
  top: [string, number][]
}

export interface SelectionStats {
  count: number
  numbers: number
  sum: number
  min: number | null
  max: number | null
}

export interface TaskProgress {
  id: number
  kind: 'sort' | 'filter' | 'stats'
  done: number
  total: number
  finished: boolean
}

export interface CellChange {
  row: number
  col: number
  value: string
}

export interface OpenOptions {
  sheet?: string | null
  hasHeader?: boolean | null
  delimiter?: string | null
  encoding?: string | null
}

export interface OpenedFile {
  id: number
  path: string
  name: string
  format: string
  /** Where the rows come from, e.g. `$.data` for JSON. */
  detail: string | null
  /** Workbook sheets (empty for other formats) and the one shown. */
  sheets: string[]
  sheet: string | null
  /** How the file was read (detected or chosen). */
  options: OpenOptions
  /** What a plain save writes; Save as in another format converts. */
  saveFormat: ExportFormat
  columns: string[]
  fileSize: number
  view: ViewState
}

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'jsonLines' | 'xlsx'

export interface SaveSummary {
  rows: number
  /** Excel sheets written; more than one when the rows didn't fit on one sheet. */
  sheets: number
  /** Excel cells cut to 32,767 characters. */
  truncated: number
}

/** Rows one Excel sheet holds below its header row. */
export const EXCEL_SHEET_ROWS = 1_048_575

export interface IndexProgress {
  id: number
  rows: number
  /** Format-specific units (bytes or rows); only the ratio matters. */
  workDone: number
  workTotal: number
  /** Rows shown, counting rows inserted or deleted while loading. */
  viewRows: number
  done: boolean
  error: string | null
}

export interface SaveProgress {
  id: number
  rowsDone: number
  rowsTotal: number
}

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'lines' | 'blank'

export interface JsonNode {
  key: string | null
  kind: JsonKind
  /** Raw token for scalars (cut when long). */
  text: string
  count: number | null
  size: number
}

/** A JSON view edit. Values are JSON text; anything that isn't valid JSON is saved as a string. */
export type JsonEdit =
  | { op: 'set'; path: number[]; text: string }
  | { op: 'rename'; path: number[]; key: string }
  | { op: 'delete'; path: number[] }
  | { op: 'insert'; parent: number[]; index: number; key: string | null; text: string }

export interface JsonChildren {
  total: number
  complete: boolean
  children: JsonNode[]
}

export interface SearchQuery {
  text: string
  matchCase: boolean
  regex: boolean
  column: number | null
}

export interface SearchProgress {
  id: number
  searchId: number
  scanned: number
  total: number
  count: number | null
  done: boolean
}

export interface SearchHit {
  index: number
  row: number
  col: number | null
}

export const api = {
  open: (path: string, options?: OpenOptions) => invoke<OpenedFile>('open_file', { path, options: options ?? null }),
  insertColumn: (id: number, at: number, name: string) => invoke<ViewState>('insert_column', { id, at, name }),
  deleteColumns: (id: number, cols: number[]) => invoke<ViewState>('delete_columns', { id, cols }),
  renameColumn: (id: number, col: number, name: string) => invoke<ViewState>('rename_column', { id, col, name }),
  moveColumn: (id: number, from: number, to: number) => invoke<ViewState>('move_column', { id, from, to }),
  close: (id: number) => invoke<void>('close_file', { id }),
  viewState: (id: number) => invoke<ViewState>('view_state', { id }),
  rows: (id: number, start: number, count: number) => invoke<string[][]>('get_rows', { id, start, count }),
  setCells: (id: number, changes: CellChange[]) => invoke<ViewState>('set_cells', { id, changes }),
  insertRows: (id: number, at: number, count: number) => invoke<ViewState>('insert_rows', { id, at, count }),
  deleteRows: (id: number, start: number, count: number) => invoke<ViewState>('delete_rows', { id, start, count }),
  undo: (id: number) => invoke<ViewState>('undo', { id }),
  redo: (id: number) => invoke<ViewState>('redo', { id }),
  /** Saves over the file, or to `path`; `format` converts and `viewOnly` writes just the sorted / filtered rows. */
  save: (id: number, path?: string, format?: ExportFormat, viewOnly?: boolean) =>
    invoke<SaveSummary>('save_file', { id, path, format: format ?? null, viewOnly: viewOnly ?? null }),
  saveCancel: (id: number) => invoke<void>('save_cancel', { id }),
  searchStart: (id: number, query: SearchQuery) => invoke<number>('search_start', { id, query }),
  searchStop: (id: number) => invoke<void>('search_stop', { id }),
  searchSeek: (id: number, args: { index?: number; row?: number; forward: boolean }) =>
    invoke<SearchHit | null>('search_seek', { id, index: args.index ?? null, row: args.row ?? null, forward: args.forward }),
  searchReplace: (id: number, rows: number[] | undefined, replacement: string) =>
    invoke<{ view: ViewState; cells: number }>('search_replace', { id, rows: rows ?? null, replacement }),
  viewApply: (id: number, spec: ViewSpec) => invoke<ViewState>('view_apply', { id, spec }),
  viewClear: (id: number) => invoke<ViewState>('view_clear', { id }),
  columnStats: (id: number, col: number) => invoke<ColumnStats>('column_stats', { id, col }),
  taskCancel: (id: number) => invoke<void>('task_cancel', { id }),
  /** Size and modified time per path; null for files that no longer exist. */
  fileInfo: (paths: string[]) => invoke<(FileInfo | null)[]>('file_info', { paths }),
  selectionStats: (id: number, start: number, count: number, cols: number[]) =>
    invoke<SelectionStats>('selection_stats', { id, start, count, cols }),
  jsonRoot: (id: number) => invoke<JsonNode>('json_root', { id }),
  /** `path` is each child's position from the root. */
  jsonChildren: (id: number, path: number[], start: number, count: number) =>
    invoke<JsonChildren>('json_children', { id, path, start, count }),
  jsonRaw: (id: number, path: number[]) => invoke<string>('json_raw', { id, path }),
  jsonEdit: (id: number, edit: JsonEdit) => invoke<ViewState>('json_edit', { id, edit }),
}

export interface FileInfo {
  size: number
  modifiedMs: number | null
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export const formatCount = (n: number) => n.toLocaleString('en-IN')

export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)
}

export const CANCELLED = 'Cancelled'

/** Short number for totals: grouped, at most 4 decimals. */
export const formatNumber = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 4 })

export const FILTER_LABEL: Record<FilterKind, string> = {
  contains: 'contains',
  notContains: "doesn't contain",
  equals: 'is',
  startsWith: 'starts with',
  regex: 'matches',
  eq: '=',
  ne: '≠',
  gt: '>',
  lt: '<',
  between: 'between',
  empty: 'is empty',
  notEmpty: 'is not empty',
  oneOf: 'is one of',
}

export function describeFilter(f: Filter, columns: string[]): string {
  const name = columns[f.col] ?? `Column ${f.col + 1}`
  const label = FILTER_LABEL[f.kind]
  switch (f.kind) {
    case 'empty':
    case 'notEmpty':
      return `${name} ${label}`
    case 'between':
      return `${name} ${label} ${f.value} and ${f.value2}`
    case 'oneOf':
      return f.values.length === 1
        ? `${name} is ${JSON.stringify(f.values[0])}`
        : `${name} is one of ${f.values.length} values`
    case 'contains':
    case 'notContains':
    case 'equals':
    case 'startsWith':
      return `${name} ${label} ${JSON.stringify(f.value)}`
    default:
      return `${name} ${label} ${f.value}`
  }
}
