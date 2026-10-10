import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ask, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  api,
  errorText,
  formatBytes,
  formatCount,
  CANCELLED,
  formatNumber,
  type Filter,
  type IndexProgress,
  type OpenedFile,
  type OpenOptions,
  type ExportFormat,
  type SaveProgress,
  type SaveSummary,
  EXCEL_SHEET_ROWS,
  type SelectionStats,
  type TaskProgress,
  type ViewSpec,
  type ViewState,
} from './lib/api'
import { DataView, type DataViewHandle, type HeaderActions, type SelectionRange } from './components/DataView'
import { FilterBar } from './components/FilterBar'
import { FilterEditor } from './components/FilterEditor'
import { StatsPanel } from './components/StatsPanel'
import { JsonView, type JsonViewHandle } from './components/JsonView'
import { FindBar } from './components/FindBar'
import { AppMenu, type MenuEntry } from './components/Menu'
import { GoToRow } from './components/GoToRow'
import { FileOptions } from './components/FileOptions'
import { EXPORT_FORMATS, SaveAs, formatFromPath } from './components/SaveAs'
import { Settings, IconSettings } from './components/Settings'
import { CommandPalette } from './components/CommandPalette'
import { StartPage, type FileKind } from './components/StartPage'
import { getSettings, rememberRecent, useRecent } from './lib/settings'
import {
  IconClose,
  IconFolder,
  IconPlus,
  IconRedo,
  IconRowInsert,
  IconSave,
  IconSaveAs,
  IconSearch,
  IconBraces,
  IconCommand,
  IconFilter,
  IconCsv,
  IconSheet,
  IconTrash,
  IconUndo,
} from './components/Icons'

interface FileTab {
  file: OpenedFile
  view: ViewState
  progress?: IndexProgress
  saving?: { done: number; total: number }
  /** The user accepted that overwriting this workbook drops its formatting. */
  xlsxOverwriteOk?: boolean
  /** JSON files can be shown as a table or as JSON. */
  mode: 'table' | 'json'
  /** Bumped on every data change, so open searches refresh. */
  version: number
  /** A running sort, filter or stats pass. */
  task?: TaskProgress
}

const NO_VIEW: ViewSpec = { sort: [], filters: [] }
const TASK_LABEL: Record<TaskProgress['kind'], string> = { sort: 'Sorting…', filter: 'Filtering…', stats: 'Counting…' }

/** Key/value files and non-record data read better as JSON; arrays of records as a table. */
function defaultMode(file: OpenedFile): FileTab['mode'] {
  if (file.format !== 'json') return 'table'
  const pick = getSettings().jsonView
  if (pick !== 'auto') return pick
  const tabular = !file.detail?.includes('(keys)') && !(file.columns.length === 1 && file.columns[0] === 'value')
  return tabular ? 'table' : 'json'
}

const EXTENSIONS: Record<string, string[]> = {
  csv: ['csv', 'tsv', 'txt'],
  json: ['json', 'jsonl', 'ndjson'],
  xlsx: ['xlsx', 'xlsm'],
}
const OPEN_FILTERS = [
  { name: 'Data files', extensions: Object.values(EXTENSIONS).flat() },
  { name: 'CSV', extensions: EXTENSIONS.csv },
  { name: 'JSON', extensions: EXTENSIONS.json },
  { name: 'Excel', extensions: EXTENSIONS.xlsx },
]
const FORMAT_LABEL: Record<string, string> = { csv: 'CSV', json: 'JSON', xlsx: 'Excel' }
const isMac = navigator.userAgent.includes('Mac')
/** `activeId` of the built-in Settings tab (file ids start at 0 and go up). */
const SETTINGS_TAB = -1

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

export default function App() {
  const [tabs, setTabs] = useState<FileTab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [dragging, setDragging] = useState(false)
  const recent = useRecent()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [goTo, setGoTo] = useState(false)
  const [find, setFind] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const filterButton = useRef<HTMLButtonElement>(null)
  /** The Save as / Export current view popover, hanging off the Save as button. */
  const [saveAs, setSaveAs] = useState<{ viewOnly: boolean; at: { x: number; y: number } } | null>(null)
  const saveAsButton = useRef<HTMLButtonElement>(null)
  /** Where the file options popover is open (it hangs off the format pill). */
  const [optionsAt, setOptionsAt] = useState<{ x: number; y: number } | null>(null)
  /** Filter being added (`index` null) or edited. */
  const [filterEdit, setFilterEdit] = useState<{ col: number; index: number | null; at: { x: number; y: number } } | null>(null)
  const [statsFor, setStatsFor] = useState<{ id: number; col: number } | null>(null)
  const [selection, setSelection] = useState<SelectionRange | null>(null)
  const [selStats, setSelStats] = useState<SelectionStats | null>(null)
  const jsonView = useRef<JsonViewHandle>(null)
  const dataView = useRef<DataViewHandle>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const active = tabs.find((t) => t.file.id === activeId)
  /** Tab order for ⌃Tab and ⌘1–9: files, then Settings when it is open. */
  const tabIds = useMemo(() => [...tabs.map((t) => t.file.id), ...(settingsOpen ? [SETTINGS_TAB] : [])], [tabs, settingsOpen])

  const updateTab = useCallback((id: number, f: (t: FileTab) => FileTab) => {
    setTabs((ts) => ts.map((t) => (t.file.id === id ? f(t) : t)))
  }, [])

  const setView = useCallback(
    (id: number, view: ViewState) => updateTab(id, (t) => ({ ...t, view, version: t.version + 1 })),
    [updateTab],
  )

  const openPath = useCallback(async (path: string, replaceId?: number, options?: OpenOptions) => {
    const existing = tabsRef.current.find((t) => t.file.path === path)
    if (existing && replaceId === undefined) {
      setActiveId(existing.file.id)
      return
    }
    setOpening(true)
    setError(null)
    try {
      const file = await api.open(path, options)
      setTabs((ts) => {
        const i = ts.findIndex((t) => t.file.id === replaceId)
        // A reopened tab keeps the view the user picked.
        const tab: FileTab = { file, view: file.view, mode: i >= 0 ? ts[i].mode : defaultMode(file), version: 0 }
        return i >= 0 ? ts.map((t, j) => (j === i ? tab : t)) : [...ts, tab]
      })
      setActiveId(file.id)
      rememberRecent(path)
      // Small files can finish indexing before the tab exists, so their events are missed.
      setView(file.id, await api.viewState(file.id))
    } catch (e) {
      setError(`Couldn't open ${baseName(path)}: ${errorText(e)}`)
    } finally {
      setOpening(false)
    }
  }, [setView])

  /** The system picker; `kind` limits it to one type of file (from the start page). */
  const pickKind = useCallback(
    async (kind?: FileKind) => {
      const filters = kind ? OPEN_FILTERS.filter((f) => f.name === FORMAT_LABEL[kind]) : OPEN_FILTERS
      const picked = await openDialog({ multiple: true, filters })
      for (const path of picked ?? []) await openPath(path)
    },
    [openPath],
  )
  const pickFiles = useCallback(() => pickKind(), [pickKind])

  /** Asks before throwing away a tab's unsaved edits. */
  const confirmDiscard = useCallback(async (tab: FileTab, action: string) => {
    if (!tab.view.dirty) return true
    return ask(`${tab.file.name} has unsaved changes. ${action} anyway?`, {
      title: 'Unsaved changes',
      kind: 'warning',
      okLabel: 'Discard changes',
      cancelLabel: 'Cancel',
    })
  }, [])

  const closeTab = useCallback(async (id: number) => {
    if (id === SETTINGS_TAB) {
      setSettingsOpen(false)
      const ts = tabsRef.current
      setActiveId((cur) => (cur === SETTINGS_TAB ? (ts[ts.length - 1]?.file.id ?? null) : cur))
      return
    }
    const tab = tabsRef.current.find((t) => t.file.id === id)
    if (!tab || !(await confirmDiscard(tab, 'Close it'))) return
    await api.close(id).catch(() => {})
    const ts = tabsRef.current
    const i = ts.findIndex((t) => t.file.id === id)
    const rest = ts.filter((t) => t.file.id !== id)
    setTabs(rest)
    setActiveId((cur) => (cur === id ? (rest[Math.min(i, rest.length - 1)]?.file.id ?? null) : cur))
  }, [confirmDiscard])

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
    setActiveId(SETTINGS_TAB)
  }, [])

  const switchSheet = useCallback(
    async (sheet: string) => {
      const tab = tabsRef.current.find((t) => t.file.id === activeId)
      if (!tab || tab.file.sheet === sheet || !(await confirmDiscard(tab, 'Switch sheets'))) return
      await api.close(tab.file.id).catch(() => {})
      await openPath(tab.file.path, tab.file.id, { ...tab.file.options, sheet })
    },
    [activeId, confirmDiscard, openPath],
  )

  /** Reopens the active file with other read options (header, delimiter, encoding). */
  const reopenWith = useCallback(
    async (options: OpenOptions) => {
      const tab = tabsRef.current.find((t) => t.file.id === activeId)
      if (!tab || !(await confirmDiscard(tab, 'Reopen it'))) return
      await api.close(tab.file.id).catch(() => {})
      await openPath(tab.file.path, tab.file.id, options)
    },
    [activeId, confirmDiscard, openPath],
  )
  const closeOptions = useCallback(() => setOptionsAt(null), [])
  const closeFilterEdit = useCallback(() => setFilterEdit(null), [])

  // Each action reports failures in the error bar instead of throwing.
  const run = useCallback(async (f: () => Promise<void>) => {
    try {
      setError(null)
      await f()
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  /**
   * Writes the active file: over itself (no `dest`), or to `dest` in `format`.
   * `viewOnly` exports just the sorted / filtered rows and leaves the tab as it is.
   */
  const writeFile = useCallback(
    (dest: string | undefined, format: ExportFormat | undefined, viewOnly: boolean) =>
      run(async () => {
        if (!active?.view.savable || active.saving) return
        const id = active.file.id
        const native = active.file.saveFormat
        const converting = viewOnly || (format !== undefined && format !== native)
        if (converting && dest === active.file.path) {
          setError(`${active.file.name} is open here; pick another name to save the ${viewOnly ? 'view' : 'converted file'}.`)
          return
        }
        if (!converting && native === 'xlsx' && (!dest || dest === active.file.path) && !active.xlsxOverwriteOk) {
          const ok = await ask(
            'Saving rewrites the workbook. Values and their types are kept in every sheet, but cell formatting, formulas (their results stay as values), charts and macros are removed. Use Save as to keep the original untouched.',
            { title: 'Save over the original workbook?', kind: 'warning', okLabel: 'Save anyway', cancelLabel: 'Cancel' },
          )
          if (!ok) return
          updateTab(id, (t) => ({ ...t, xlsxOverwriteOk: true }))
        }
        updateTab(id, (t) => ({ ...t, saving: { done: 0, total: viewOnly ? t.view.rows : t.view.baseRows } }))
        let summary: SaveSummary
        try {
          summary = await api.save(id, dest, format, viewOnly)
        } catch (e) {
          if (errorText(e) !== CANCELLED) throw e
          setNotice('Save cancelled. Nothing was written.')
          return
        } finally {
          updateTab(id, (t) => ({ ...t, saving: undefined }))
        }
        const name = baseName(dest ?? active.file.path)
        const notes: string[] = []
        if (summary.sheets > 1)
          notes.push(`Excel holds ${formatCount(EXCEL_SHEET_ROWS)} rows per sheet, so the rows are split across Sheet1 to Sheet${summary.sheets}.`)
        if (summary.truncated > 0)
          notes.push(`${formatCount(summary.truncated)} cells were longer than Excel's 32,767-character limit and were cut.`)
        if (viewOnly) {
          setNotice([`Exported ${formatCount(summary.rows)} rows to ${name}.`, ...notes].join(' '))
          return
        }
        if (dest && dest !== active.file.path) {
          // The tab now shows the new file; the old session is closed.
          await api.close(id)
          await openPath(dest, id, converting ? {} : { sheet: active.file.sheet })
        } else {
          setView(id, await api.viewState(id))
        }
        if (notes.length > 0) setNotice([`Saved ${name}.`, ...notes].join(' '))
      }),
    [active, run, updateTab, setView, openPath],
  )

  /** Save (over the file), or open the Save as / Export current view popover. */
  const save = useCallback(
    (asNew: boolean, viewOnly = false) => {
      if (!active?.view.savable || active.saving) return
      if (!asNew) return writeFile(undefined, undefined, false)
      const r = saveAsButton.current?.getBoundingClientRect()
      setSaveAs({ viewOnly, at: r ? { x: r.left, y: r.bottom + 6 } : { x: 12, y: 96 } })
    },
    [active, writeFile],
  )

  /** After the format is picked in the popover: the system dialog for where. */
  const chooseLocation = useCallback(
    (format: ExportFormat) =>
      run(async () => {
        const viewOnly = saveAs?.viewOnly ?? false
        setSaveAs(null)
        if (!active) return
        const chosen = EXPORT_FORMATS.find((f) => f.value === format)!
        const stem = active.file.path.replace(/\.[^./\\]+$/, '')
        const defaultPath = `${stem}${viewOnly ? '-view' : ''}.${chosen.ext[0]}`
        // The picked format first; the others stay available.
        const filters = [chosen, ...EXPORT_FORMATS.filter((f) => f !== chosen)].map((f) => ({ name: f.label, extensions: f.ext }))
        const dest = await saveDialog({ defaultPath, filters })
        if (!dest) return
        await writeFile(dest, formatFromPath(dest, format), viewOnly)
      }),
    [active, run, saveAs, writeFile],
  )
  const closeSaveAs = useCallback(() => setSaveAs(null), [])

  const cancelSave = useCallback(() => {
    if (active?.saving) api.saveCancel(active.file.id).catch(() => {})
  }, [active])

  const edit = useCallback(
    (f: (id: number) => Promise<ViewState>, after?: () => void) =>
      run(async () => {
        if (!active?.view.editable || active.mode !== 'table') return
        setView(active.file.id, await f(active.file.id))
        dataView.current?.refresh()
        after?.()
      }),
    [active, run, setView],
  )

  /** Undo and redo cover edits from both the table and the JSON view. */
  const history = useCallback(
    (f: (id: number) => Promise<ViewState>) =>
      run(async () => {
        if (!active?.view.editable || active.saving) return
        setView(active.file.id, await f(active.file.id))
        dataView.current?.refresh()
      }),
    [active, run, setView],
  )
  const undo = useCallback(() => history(api.undo), [history])
  const redo = useCallback(() => history(api.redo), [history])

  const insertRow = useCallback(() => {
    if (!active?.view.structural) return
    const cur = dataView.current?.currentRow()
    const at = cur === undefined ? active.view.rows : cur + 1
    edit(
      (id) => api.insertRows(id, at, 1),
      () => dataView.current?.scrollToRow(at),
    )
  }, [active, edit])

  const deleteRows = useCallback(() => {
    if (!active?.view.structural) return
    const runs = dataView.current?.selectedRuns() ?? []
    if (runs.length === 0) {
      setError('Select rows (click the row numbers) or a cell to delete its row.')
      return
    }
    edit(async (id) => {
      let view: ViewState | undefined
      for (const [start, count] of runs) view = await api.deleteRows(id, start, count)
      return view!
    })
  }, [active, edit])

  const openFind = useCallback(() => setFind((n) => (n ?? 0) + 1), [])

  /** Sorts / filters the table; an empty spec shows the file order again. */
  const applyView = useCallback(
    async (spec: ViewSpec) => {
      if (!active) return
      const id = active.file.id
      setError(null)
      try {
        const empty = spec.sort.length === 0 && spec.filters.length === 0
        const v = empty ? await api.viewClear(id) : await api.viewApply(id, spec)
        setView(id, v)
        dataView.current?.refresh()
        dataView.current?.scrollToRow(0)
      } catch (e) {
        if (errorText(e) !== CANCELLED) setError(errorText(e))
      }
    },
    [active, setView],
  )

  const spec = active?.view.view ?? NO_VIEW
  const headerActions = useMemo<HeaderActions>(
    () => ({
      sort: (col, desc, then) =>
        applyView({ ...spec, sort: then ? [...spec.sort.filter((k) => k.col !== col), { col, desc }] : [{ col, desc }] }),
      clearSort: (col) => applyView({ ...spec, sort: spec.sort.filter((k) => k.col !== col) }),
      filter: (col, at) => setFilterEdit({ col, index: null, at }),
      stats: (col) => active && setStatsFor({ id: active.file.id, col }),
    }),
    [spec, applyView, active],
  )

  /** Toolbar Filter button and palette: a new filter on the focused column (the first one if none). */
  const filterCurrent = useCallback(() => {
    const r = filterButton.current?.getBoundingClientRect()
    setFilterEdit({ col: dataView.current?.currentCol() ?? 0, index: null, at: r ? { x: r.left, y: r.bottom + 6 } : { x: 12, y: 96 } })
  }, [])
  const statsCurrent = useCallback(() => {
    if (active) setStatsFor({ id: active.file.id, col: dataView.current?.currentCol() ?? 0 })
  }, [active])

  const saveFilter = useCallback(
    (filter: Filter, index: number | null) => {
      setFilterEdit(null)
      const filters = index === null ? [...spec.filters, filter] : spec.filters.map((f, i) => (i === index ? filter : f))
      applyView({ ...spec, filters })
    },
    [spec, applyView],
  )

  const removeFilter = useCallback(
    (index: number) => {
      setFilterEdit(null)
      applyView({ ...spec, filters: spec.filters.filter((_, i) => i !== index) })
    },
    [spec, applyView],
  )

  const cancelTask = useCallback(() => {
    if (active?.task) api.taskCancel(active.file.id).catch(() => {})
  }, [active])

  // Notices are toasts that close themselves; errors stay until dismissed.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  // Status bar totals for the selected cells, computed after the selection settles.
  const activeVersion = active?.version
  useEffect(() => {
    setSelStats(null)
    if (!selection || !active || active.mode !== 'table') return
    const id = active.file.id
    const timer = setTimeout(() => {
      api
        .selectionStats(id, selection.start, selection.count, selection.cols)
        .then(setSelStats)
        .catch(() => setSelStats(null))
    }, 200)
    return () => clearTimeout(timer)
    // Recomputed when the data changes too (activeVersion).
  }, [selection, active?.file.id, active?.mode, activeVersion])

  const jumpTo = useCallback(
    (row: number, col: number | null) => {
      if (active?.mode === 'json') jsonView.current?.reveal(row)
      else dataView.current?.scrollToRow(row, col ?? 0)
    },
    [active?.mode],
  )

  const goToRow = useCallback((row: number) => {
    setGoTo(false)
    dataView.current?.scrollToRow(row)
  }, [])

  const cycleTab = useCallback(
    (step: number) => {
      const i = tabIds.indexOf(activeId ?? NaN)
      if (tabIds.length > 1) setActiveId(tabIds[(i + step + tabIds.length) % tabIds.length])
    },
    [tabIds, activeId],
  )

  // Backend events: indexing and save progress.
  useEffect(() => {
    const offIndex = listen<IndexProgress>('index-progress', ({ payload: p }) => {
      updateTab(p.id, (t) => ({
        ...t,
        progress: p,
        // Rows keep arriving at the end until loading finishes.
        view: t.view.loading ? { ...t.view, rows: p.viewRows, baseRows: p.viewRows } : t.view,
      }))
      if (p.error) setError(p.error)
      if (p.done)
        api
          .viewState(p.id)
          .then((v) => setView(p.id, v))
          .catch(() => {})
    })
    const offSave = listen<SaveProgress>('save-progress', ({ payload: p }) => {
      updateTab(p.id, (t) => (t.saving ? { ...t, saving: { done: p.rowsDone, total: p.rowsTotal } } : t))
    })
    const offTask = listen<TaskProgress>('task-progress', ({ payload: p }) => {
      updateTab(p.id, (t) => ({ ...t, task: p.finished ? undefined : p }))
    })
    return () => {
      offIndex.then((f) => f())
      offSave.then((f) => f())
      offTask.then((f) => f())
    }
  }, [updateTab, setView])

  // Files dropped onto the window.
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      setDragging(payload.type === 'over' || payload.type === 'enter')
      if (payload.type === 'drop') for (const path of payload.paths) await openPath(path)
    })
    return () => {
      off.then((f) => f())
    }
  }, [openPath])

  // Warn before quitting with unsaved edits.
  useEffect(() => {
    const off = getCurrentWindow().onCloseRequested(async (e) => {
      const dirty = tabsRef.current.filter((t) => t.view.dirty)
      if (dirty.length === 0) return
      const names = dirty.map((t) => t.file.name).join(', ')
      const quit = await ask(`Unsaved changes in ${names}. Quit anyway?`, {
        title: 'Unsaved changes',
        kind: 'warning',
        okLabel: 'Quit',
        cancelLabel: 'Cancel',
      })
      if (!quit) e.preventDefault()
    })
    return () => {
      off.then((f) => f())
    }
  }, [])

  // Keyboard shortcuts. Each one is also in the toolbar or the ⋮ menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && active?.saving) {
        cancelSave()
        return
      }
      if (e.key === 'Escape' && active?.task) {
        cancelTask()
        return
      }
      // ⌃Tab / ⌃⇧Tab switch tabs on every platform.
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      const inText = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (/^[1-9]$/.test(e.key)) {
        const tab = e.key === '9' ? tabIds[tabIds.length - 1] : tabIds[Number(e.key) - 1]
        if (tab !== undefined) {
          e.preventDefault()
          setActiveId(tab)
        }
        return
      }
      const table = active?.mode === 'table'
      const actions: Record<string, (() => void) | undefined> = {
        o: pickFiles,
        s: () => save(e.shiftKey),
        w: activeId !== null ? () => closeTab(activeId) : undefined,
        ',': openSettings,
        k: () => setPalette((p) => !p),
        z: inText ? undefined : e.shiftKey ? redo : undo,
        y: inText ? undefined : redo,
        g: active && table ? () => setGoTo(true) : undefined,
        f: active ? openFind : undefined,
        enter: table && !inText ? insertRow : undefined,
        backspace: table && !inText ? deleteRows : undefined,
      }
      const action = actions[e.key.toLowerCase()]
      if (action) {
        e.preventDefault()
        action()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickFiles, save, closeTab, undo, redo, insertRow, deleteRows, cycleTab, openFind, cancelTask, cancelSave, openSettings, tabIds, activeId, active])

  const showStats = !!active && active.mode === 'table' && statsFor?.id === active.file.id
  const savable = !!active?.view.savable && !active.saving
  const editable = !!active?.view.editable && !active.saving
  const structural = editable && active?.mode === 'table' && !!active?.view.structural
  const mod = isMac ? '⌘' : 'Ctrl+'
  const shift = isMac ? '⇧' : 'Shift+'

  const canFilter = !!active && active.mode === 'table' && !active.view.loading && !active.task
  const menu: MenuEntry[] = [
    { label: 'Command palette…', shortcut: `${mod}K`, onSelect: () => setPalette(true) },
    'separator',
    { label: 'Open file…', shortcut: `${mod}O`, onSelect: pickFiles },
    { label: 'Save', shortcut: `${mod}S`, disabled: !savable || !active?.view.dirty, onSelect: () => save(false) },
    { label: 'Save as…', shortcut: `${mod}${shift}S`, disabled: !savable, onSelect: () => save(true) },
    {
      label: 'Export current view…',
      disabled: !savable || !active?.view.view || active.mode !== 'table',
      onSelect: () => save(true, true),
    },
    { label: 'Close tab', shortcut: `${mod}W`, disabled: activeId === null, onSelect: () => activeId !== null && closeTab(activeId) },
    'separator',
    { label: 'Undo', shortcut: `${mod}Z`, disabled: !editable || !active?.view.canUndo, onSelect: undo },
    { label: 'Redo', shortcut: `${mod}${shift}Z`, disabled: !editable || !active?.view.canRedo, onSelect: redo },
    { label: 'Insert row below', shortcut: `${mod}↵`, disabled: !structural, onSelect: insertRow },
    { label: 'Delete selected rows', shortcut: `${mod}⌫`, disabled: !structural, onSelect: deleteRows },
    'separator',
    { label: 'Filter current column…', disabled: !canFilter, onSelect: filterCurrent },
    { label: 'Statistics for current column', disabled: !active || active.mode !== 'table' || active.view.loading, onSelect: statsCurrent },
    { label: 'Re-apply sort and filter', disabled: !active?.view.viewStale || !!active?.task, onSelect: () => applyView(spec) },
    { label: 'Clear sort and filter', disabled: !active?.view.view || !!active?.task, onSelect: () => applyView(NO_VIEW) },
    'separator',
    { label: 'Find and replace…', shortcut: `${mod}F`, disabled: !active, onSelect: openFind },
    { label: 'Go to row…', shortcut: `${mod}G`, disabled: !active || active.mode !== 'table', onSelect: () => setGoTo(true) },
    { label: 'Expand all (JSON)', disabled: active?.mode !== 'json', onSelect: () => jsonView.current?.expandAll() },
    { label: 'Collapse all (JSON)', disabled: active?.mode !== 'json', onSelect: () => jsonView.current?.collapseAll() },
    { label: 'Next tab', shortcut: '⌃Tab', disabled: tabIds.length < 2, onSelect: () => cycleTab(1) },
    { label: 'Previous tab', shortcut: '⌃⇧Tab', disabled: tabIds.length < 2, onSelect: () => cycleTab(-1) },
    'separator',
    { label: 'Settings', shortcut: `${mod},`, onSelect: openSettings },
  ]

  return (
    <div className={`app${isMac ? ' mac' : ''}`}>
      <div className="tabstrip" data-tauri-drag-region>
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <div
              key={t.file.id}
              role="tab"
              aria-selected={t.file.id === activeId}
              className={`tab${t.file.id === activeId ? ' active' : ''}`}
              title={t.file.path}
              onMouseDown={(e) => {
                if (e.button === 1) closeTab(t.file.id)
                else setActiveId(t.file.id)
              }}
            >
              <span className={`tab-icon kind-${t.file.format}`}>
                {t.progress?.done === false ? <span className="spinner" /> : <FileIcon format={t.file.format} />}
              </span>
              <span className="tab-title">{t.file.name}</span>
              {t.view.dirty && <span className="tab-dirty" title="Unsaved changes" />}
              <button
                className="tab-close"
                aria-label={`Close ${t.file.name}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(t.file.id)}
              >
                <IconClose />
              </button>
            </div>
          ))}
          {settingsOpen && (
            <div
              role="tab"
              aria-selected={activeId === SETTINGS_TAB}
              className={`tab${activeId === SETTINGS_TAB ? ' active' : ''}`}
              onMouseDown={(e) => {
                if (e.button === 1) closeTab(SETTINGS_TAB)
                else setActiveId(SETTINGS_TAB)
              }}
            >
              <span className="tab-icon">
                <IconSettings />
              </span>
              <span className="tab-title">Settings</span>
              <button
                className="tab-close"
                aria-label="Close Settings"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(SETTINGS_TAB)}
              >
                <IconClose />
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn new-tab" title={`Open file (${mod}O)`} onClick={pickFiles}>
          <IconPlus />
        </button>
        <div className="tabstrip-drag" data-tauri-drag-region />
      </div>

      <div className="toolbar">
        <div className="toolbar-group">
          <button className="icon-btn" title={`Open file (${mod}O)`} onClick={pickFiles}>
            <IconFolder />
          </button>
          <button
            className="icon-btn"
            title={`Save (${mod}S)`}
            disabled={!savable || !active?.view.dirty}
            onClick={() => save(false)}
          >
            <IconSave />
          </button>
          <button
            ref={saveAsButton}
            className="icon-btn"
            title={`Save as… (${mod}⇧S)`}
            disabled={!savable}
            // Keeps the popover's outside-click handler from closing it just before this click toggles it.
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={() => (saveAs ? setSaveAs(null) : save(true))}
          >
            <IconSaveAs />
          </button>
        </div>
        <span className="toolbar-sep" />
        <div className="toolbar-group">
          <button className="icon-btn" title={`Undo (${mod}Z)`} disabled={!editable || !active?.view.canUndo} onClick={undo}>
            <IconUndo />
          </button>
          <button className="icon-btn" title={`Redo (${mod}⇧Z)`} disabled={!editable || !active?.view.canRedo} onClick={redo}>
            <IconRedo />
          </button>
        </div>
        <span className="toolbar-sep" />
        <div className="toolbar-group">
          <button
            className="icon-btn"
            title={active?.view.view ? 'Clear sort and filter to insert or delete' : `Insert row below selection (${mod}↵)`}
            disabled={!structural}
            onClick={insertRow}
          >
            <IconRowInsert />
          </button>
          <button
            className="icon-btn"
            title={active?.view.view ? 'Clear sort and filter to insert or delete' : `Delete selected rows (${mod}⌫)`}
            disabled={!structural}
            onClick={deleteRows}
          >
            <IconTrash />
          </button>
        </div>
        {active?.file.format === 'json' && (
          <>
            <span className="toolbar-sep" />
            <div className="chips" role="radiogroup" aria-label="View">
              {(['table', 'json'] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={active.mode === m}
                  className={`chip${active.mode === m ? ' active' : ''}`}
                  disabled={m === 'json' && !!active.view.view}
                  title={m === 'json' && active.view.view ? 'Clear sort and filter to use the JSON view' : undefined}
                  onClick={() => updateTab(active.file.id, (t) => ({ ...t, mode: m }))}
                >
                  {m === 'table' ? 'Table' : 'JSON'}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="grow" />
        {active?.mode === 'table' && (
          <button
            ref={filterButton}
            className="text-btn"
            title="Filter the focused column"
            disabled={!canFilter}
            // Keeps the filter popover's outside-click handler from closing it as it opens.
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={filterCurrent}
          >
            <IconFilter />
            <span className="label">Filter</span>
          </button>
        )}
        <button className="text-btn" title={`Find and replace (${mod}F)`} disabled={!active} onClick={openFind}>
          <IconSearch />
          <span className="label">Find</span>
        </button>
        <button className="text-btn palette-hint" title={`All commands (${mod}K)`} onClick={() => setPalette(true)}>
          <IconCommand />
          <kbd>{mod}K</kbd>
        </button>
        {opening && (
          <span className="status-pill">
            <span className="spinner" />
            Opening…
          </span>
        )}
        {active && (
          <button
            className="status-pill clickable"
            title={`${active.file.path}\nClick to change how the file is read`}
            aria-haspopup="dialog"
            aria-expanded={optionsAt !== null}
            disabled={opening || !!active.saving}
            // Keeps the popover's outside-click handler from closing it just before this click toggles it.
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={(e) => {
              if (optionsAt) return setOptionsAt(null)
              const r = e.currentTarget.getBoundingClientRect()
              setOptionsAt({ x: r.right, y: r.bottom + 6 })
            }}
          >
            {[FORMAT_LABEL[active.file.format], active.file.detail, formatBytes(active.file.fileSize)]
              .filter(Boolean)
              .join(' · ')}
          </button>
        )}
        {optionsAt && active && (
          <FileOptions
            format={active.file.format}
            options={active.file.options}
            at={optionsAt}
            onChange={reopenWith}
            onClose={closeOptions}
          />
        )}
        <AppMenu entries={menu} />
      </div>

      {active?.view.view && active.mode === 'table' && (
        <FilterBar
          spec={active.view.view}
          columns={active.view.columns}
          rows={active.view.rows}
          baseRows={active.view.baseRows}
          stale={active.view.viewStale}
          busy={!!active.task}
          onRemoveSort={(i) => applyView({ ...spec, sort: spec.sort.filter((_, j) => j !== i) })}
          onEditFilter={(index, at) => setFilterEdit({ col: spec.filters[index].col, index, at })}
          onRemoveFilter={removeFilter}
          onReapply={() => applyView(spec)}
          onClearAll={() => applyView(NO_VIEW)}
          onExport={savable ? () => save(true, true) : undefined}
        />
      )}

      {filterEdit && active && (
        <FilterEditor
          key={`${active.file.id}:${filterEdit.col}:${filterEdit.index}`}
          id={active.file.id}
          col={filterEdit.col}
          column={active.view.columns[filterEdit.col] ?? ''}
          initial={filterEdit.index === null ? undefined : spec.filters[filterEdit.index]}
          at={filterEdit.at}
          onApply={(f) => saveFilter(f, filterEdit.index)}
          onRemove={filterEdit.index === null ? undefined : () => removeFilter(filterEdit.index!)}
          onClose={closeFilterEdit}
        />
      )}

      {find !== null && active && (
        <FindBar
          key={active.file.id}
          id={active.file.id}
          columns={active.view.columns}
          dataVersion={active.version}
          focusSignal={find}
          editable={active.view.editable && active.mode === 'table'}
          currentRow={() => dataView.current?.currentRow() ?? 0}
          onJump={jumpTo}
          onView={(v) => {
            setView(active.file.id, v)
            dataView.current?.refresh()
          }}
          onError={setError}
          onNotice={setNotice}
          onClose={() => setFind(null)}
        />
      )}

      {goTo && active && active.mode === 'table' && (
        <GoToRow rows={active.view.rows} onGo={goToRow} onClose={() => setGoTo(false)} />
      )}

      {error && (
        <div className="error-box" role="alert">
          <span className="grow">{error}</span>
          <button className="tab-close" aria-label="Dismiss" onClick={() => setError(null)}>
            <IconClose />
          </button>
        </div>
      )}

      {notice && (
        <div className="notice-bar toast" role="status">
          <span className="grow">{notice}</span>
          <button className="tab-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <IconClose />
          </button>
        </div>
      )}

      <div className={`content${showStats ? ' with-panel' : ''}`}>
        {activeId === SETTINGS_TAB ? (
          <Settings onOpen={(path) => void openPath(path)} />
        ) : active?.mode === 'json' ? (
          <JsonView
            key={active.file.id}
            ref={jsonView}
            detail={active.file.detail}
            id={active.file.id}
            rows={active.view.rows}
            dataVersion={active.version}
            editable={active.view.editable && !active.saving}
            onView={(v) => setView(active.file.id, v)}
            onError={setError}
          />
        ) : active ? (
          <DataView
            key={active.file.id}
            ref={dataView}
            file={active.file}
            view={active.view}
            busy={!!active.task}
            actions={headerActions}
            onView={(v) => setView(active.file.id, v)}
            onSelection={setSelection}
            onError={setError}
          />
        ) : (
          <StartPage recent={recent} opening={opening} dragging={dragging} onPick={pickKind} onOpen={(path) => void openPath(path)} />
        )}
        {showStats && active && statsFor && (
          <StatsPanel
            key={`${statsFor.id}:${statsFor.col}`}
            id={active.file.id}
            col={statsFor.col}
            column={active.view.columns[statsFor.col] ?? ''}
            dataVersion={active.version}
            filtered={spec.filters.length > 0}
            onFilterValue={(v) =>
              applyView({
                ...spec,
                filters: [...spec.filters, { col: statsFor.col, kind: 'oneOf', value: '', value2: '', values: [v], matchCase: true }],
              })
            }
            onClose={() => setStatsFor(null)}
          />
        )}
      </div>

      {active && active.file.sheets.length > 1 && (
        <div className="sheetbar" role="tablist" aria-label="Sheets">
          {active.file.sheets.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={name === active.file.sheet}
              className={`sheet-tab${name === active.file.sheet ? ' active' : ''}`}
              disabled={opening}
              onClick={() => switchSheet(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {saveAs && active && (
        <SaveAs
          viewOnly={saveAs.viewOnly}
          native={active.file.saveFormat}
          rows={saveAs.viewOnly ? active.view.rows : active.view.baseRows}
          columns={active.view.columns.length}
          at={saveAs.at}
          onChoose={chooseLocation}
          onClose={closeSaveAs}
        />
      )}

      {dragging && activeId !== null && <div className="drop-overlay">Drop to open</div>}

      {palette && <CommandPalette entries={menu} onClose={() => setPalette(false)} />}

      {active && <StatusBar tab={active} selection={selStats} onCancelTask={cancelTask} onCancelSave={cancelSave} />}
    </div>
  )
}

function FileIcon({ format }: { format: string }) {
  if (format === 'xlsx') return <IconSheet size={14} />
  if (format === 'json') return <IconBraces size={14} />
  return <IconCsv size={14} />
}

function StatusBar({
  tab,
  selection,
  onCancelTask,
  onCancelSave,
}: {
  tab: FileTab
  selection: SelectionStats | null
  onCancelTask: () => void
  onCancelSave: () => void
}) {
  const { view, progress, saving, file, task } = tab
  const indexing = progress !== undefined && !progress.done
  const reading = file.format === 'xlsx' ? 'Reading sheet' : 'Indexing'
  const percent = indexing ? Math.min(100, Math.floor((100 * progress.workDone) / Math.max(1, progress.workTotal))) : 0
  return (
    <div className="statusbar">
      <span>
        <strong>{formatCount(view.rows)}</strong>
        {view.view && view.view.filters.length > 0 ? ` of ${formatCount(view.baseRows)}` : ''} rows · {view.columns.length} columns
      </span>
      {indexing && (
        <>
          <span className="statusbar-progress">
            <i style={{ width: `${percent}%` }} />
          </span>
          <span title="You can scroll and edit now; saving unlocks when it finishes">
            {reading} {percent}%
          </span>
        </>
      )}
      {saving && (
        <>
          <span className="statusbar-progress">
            <i style={{ width: `${(100 * saving.done) / Math.max(1, saving.total)}%` }} />
          </span>
          <span>Saving…</span>
          <button className="btn small" title="Stop and delete the partly written file (Esc)" onClick={onCancelSave}>
            Cancel
          </button>
        </>
      )}
      {task && (
        <>
          <span className="statusbar-progress">
            <i style={{ width: `${(100 * task.done) / Math.max(1, task.total)}%` }} />
          </span>
          <span>{TASK_LABEL[task.kind]}</span>
          <button className="btn small" title="Stop (Esc)" onClick={onCancelTask}>
            Cancel
          </button>
        </>
      )}
      {progress?.error && <span>Read-only: the file couldn't be read completely</span>}
      <span className="grow" />
      {selection && selection.count > 0 && (
        <span>
          Count <strong>{formatCount(selection.count)}</strong>
          {selection.numbers > 0 && (
            <>
              {' '}· Sum <strong>{formatNumber(selection.sum)}</strong> · Average{' '}
              <strong>{formatNumber(selection.sum / selection.numbers)}</strong>
            </>
          )}
        </span>
      )}
      {view.savable && !saving && <span>{view.dirty ? 'Unsaved changes' : 'All changes saved'}</span>}
    </div>
  )
}
