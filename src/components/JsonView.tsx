import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState, type CSSProperties } from 'react'
import { api, errorText, formatBytes, formatCount, type JsonEdit, type JsonNode, type ViewState } from '../lib/api'
import { LINE_HEIGHT, useSettings } from '../lib/settings'
import { IconPlus, IconTrash } from './Icons'

const PAGE = 200
const INDENT = 18
/** Containers up to this size can be edited as JSON text in one go. */
const MAX_EDIT_TEXT = 1 << 20
/** Insert position meaning "at the end" (the backend clamps it). */
const END = Number.MAX_SAFE_INTEGER

/** An expanded container: its children load in pages, and any of them can be expanded too. */
class Open {
  total: number
  complete = false
  loaded = false
  pages = new Map<number, JsonNode[]>()
  loading = new Set<number>()
  open = new Map<number, Open>()
  /** "Expand all": containers among this one's children open as their pages load. */
  expandAll = false

  constructor(
    public node: JsonNode,
    /** Child positions from the root; identifies the node. */
    public path: number[],
    /** The JSON Lines root has no brackets of its own. */
    public brackets: boolean,
  ) {
    this.total = node.count ?? 0
  }

  child(i: number) {
    return this.pages.get(Math.floor(i / PAGE))?.[i % PAGE]
  }

  /** Lines this container takes up while expanded. */
  size(): number {
    let n = this.total + (this.brackets ? 2 : 0)
    for (const c of this.open.values()) n += c.size() - 1
    return n
  }

  /** Drops loaded children so they are fetched again (after an edit). */
  invalidate() {
    this.pages.clear()
    this.loaded = false
    this.open.forEach((c) => c.invalidate())
  }
}

type Line =
  | { type: 'open'; o: Open; depth: number; last: boolean; index: number | null }
  | { type: 'child'; parent: Open; index: number; depth: number; last: boolean }
  | { type: 'close'; o: Open; depth: number; last: boolean }

/** Finds what sits on visible line `i` of container `o`. */
function resolve(o: Open, i: number, depth: number, last: boolean, index: number | null): Line | null {
  if (o.brackets) {
    if (i === 0) return { type: 'open', o, depth, last, index }
    i--
  }
  const childDepth = o.brackets ? depth + 1 : depth
  const child = (k: number): Line => ({ type: 'child', parent: o, index: k, depth: childDepth, last: k === o.total - 1 })
  let pos = 0
  for (const ci of [...o.open.keys()].sort((a, b) => a - b)) {
    const gap = ci - pos
    if (i < gap) return child(pos + i)
    i -= gap
    const c = o.open.get(ci)!
    const size = c.size()
    if (i < size) return resolve(c, i, childDepth, ci === o.total - 1, ci)
    i -= size
    pos = ci + 1
  }
  const rest = o.total - pos
  if (i < rest) return child(pos + i)
  i -= rest
  return o.brackets && i === 0 ? { type: 'close', o, depth, last } : null
}

const isContainer = (n: JsonNode) => n.kind === 'object' || n.kind === 'array'

function summary(n: JsonNode) {
  if (n.count === null) return formatBytes(n.size)
  const noun = n.kind === 'object' ? 'key' : 'item'
  return `${formatCount(n.count)} ${noun}${n.count === 1 ? '' : 's'}`
}

export interface JsonViewHandle {
  /** Opens the rows container and scrolls to row `row` in it. */
  reveal(row: number): Promise<void>
  expandAll(): void
  collapseAll(): void
}

/** Opens every loaded container below `o` and marks them so later pages open too. */
function expandDeep(o: Open) {
  o.expandAll = true
  for (const [page, children] of o.pages) openContainers(o, page, children)
  o.open.forEach(expandDeep)
}

function openContainers(o: Open, page: number, children: JsonNode[]) {
  children.forEach((node, i) => {
    const index = page * PAGE + i
    if (isContainer(node) && !o.open.has(index)) {
      const c = new Open(node, [...o.path, index], true)
      c.expandAll = true
      o.open.set(index, c)
    }
  })
}

/** Moves expanded children at or after `at` by `delta` positions (after an insert or delete). */
function shiftOpen(o: Open, at: number, delta: number) {
  const moved = new Map<number, Open>()
  for (const [i, c] of o.open) {
    if (delta < 0 && i === at) continue
    const j = i >= at ? i + delta : i
    if (j !== i) repath(c, [...o.path, j])
    moved.set(j, c)
  }
  o.open = moved
}

function repath(o: Open, path: number[]) {
  o.path = path
  for (const [i, c] of o.open) repath(c, [...path, i])
}

/** Line of child `k` relative to `o`'s first line. */
function childLine(o: Open, k: number) {
  let line = (o.brackets ? 1 : 0) + k
  for (const [ci, c] of o.open) if (ci < k) line += c.size() - 1
  return line
}

/** Line of `target`'s opening line relative to `o`'s first line. */
function openLine(o: Open, target: Open): number | null {
  for (const [ci, c] of o.open) {
    if (c === target) return childLine(o, ci)
    const inner = openLine(c, target)
    if (inner !== null) return childLine(o, ci) + inner
  }
  return null
}

/** The key of the rows container from the path label, e.g. `$.data` → `data`. */
function rowsKey(detail: string | null): string | null {
  if (!detail) return null
  if (detail.startsWith('$.')) return detail.slice(2)
  if (detail.startsWith('$[')) {
    try {
      return JSON.parse(detail.slice(2, -1))
    } catch {
      return null
    }
  }
  return null
}

/** What a line points at, for edits: the node, its path, and its container. */
function target(line: Line): { node: JsonNode | undefined; path: number[]; parent: Open | null; index: number | null } {
  if (line.type === 'child') {
    return { node: line.parent.child(line.index), path: [...line.parent.path, line.index], parent: line.parent, index: line.index }
  }
  return { node: line.o.node, path: line.o.path, parent: null, index: line.o.path.length ? line.o.path[line.o.path.length - 1] : null }
}

const samePath = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Inline editor or add form. */
type Editing =
  | { kind: 'value'; path: number[]; text: string; multiline: boolean }
  | { kind: 'key'; path: number[]; text: string }
  | { kind: 'add'; parent: number[]; index: number; object: boolean; key: string; text: string }

interface Props {
  /** Where the rows sit, e.g. `$`, `$.data` or `JSON Lines`. */
  detail: string | null
  id: number
  /** Changes while the file is still being indexed, so totals refresh. */
  rows: number
  /** Bumped on every data change (edits here or in the table, undo). */
  dataVersion: number
  editable: boolean
  onView: (view: ViewState) => void
  onError: (message: string) => void
}

export const JsonView = forwardRef<JsonViewHandle, Props>(function JsonView(
  { id, detail, rows, dataVersion, editable, onView, onError },
  ref,
) {
  const LINE = LINE_HEIGHT[useSettings().density]
  const [root, setRoot] = useState<Open | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(0)
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const seenVersion = useRef(dataVersion)

  const load = useCallback(
    (o: Open, page: number): Promise<void> => {
      if (o.loading.has(page) || o.pages.has(page)) return Promise.resolve()
      o.loading.add(page)
      return api
        .jsonChildren(id, o.path, page * PAGE, PAGE)
        .then((res) => {
          o.pages.set(page, res.children)
          o.total = res.total
          o.complete = res.complete
          o.loaded = true
          // Children may have changed under expanded nodes: keep them in step.
          res.children.forEach((node, i) => {
            const c = o.open.get(page * PAGE + i)
            if (!c) return
            if (isContainer(node)) c.node = node
            else o.open.delete(page * PAGE + i)
          })
          for (const i of o.open.keys()) if (i >= o.total) o.open.delete(i)
          if (o.expandAll) openContainers(o, page, res.children)
        })
        .catch((e) => onError(errorText(e)))
        .finally(() => {
          o.loading.delete(page)
          redraw()
        })
    },
    [id, onError],
  )

  /** Loads the root, or reloads an existing tree in place (expanded nodes stay open). */
  const loadRoot = useCallback(
    (keep: Open | null) =>
      api
        .jsonRoot(id)
        .then((node) => {
          if (keep) {
            keep.node = node
            keep.total = node.count ?? keep.total
            keep.invalidate()
            load(keep, 0)
            redraw()
            return
          }
          const o = new Open(node, [], node.kind !== 'lines')
          setRoot(o)
          load(o, 0)
        })
        .catch((e) => onError(errorText(e))),
    [id, load, onError],
  )

  useEffect(() => {
    loadRoot(null)
  }, [loadRoot])

  // Data changed (edits here or in the table, undo): reload what is shown.
  useEffect(() => {
    if (dataVersion === seenVersion.current || !root) return
    seenVersion.current = dataVersion
    loadRoot(root)
  }, [dataVersion, root, loadRoot])

  // While the rows are still being indexed, refresh containers whose totals are growing.
  useEffect(() => {
    if (!root) return
    const refresh = (o: Open) => {
      if (o.loaded && !o.complete) {
        o.pages.clear()
        load(o, 0)
      }
      o.open.forEach(refresh)
    }
    refresh(root)
  }, [rows, root, load])

  useEffect(() => {
    const el = body.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = root ? root.size() : 0
  const perPage = Math.max(1, Math.floor(height / LINE))
  const maxTop = Math.max(0, total - perPage)
  const clampTop = useCallback((t: number) => Math.min(Math.max(0, t), maxTop), [maxTop])

  useEffect(() => {
    setTop((t) => clampTop(t))
  }, [clampTop])

  // Wheel scrolling is handled here because millions of lines exceed the browser's maximum element height.
  useEffect(() => {
    const el = body.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / LINE
      setTop((t) => clampTop(t + lines))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [clampTop, LINE])

  // The tree changes in place, so the few visible lines are resolved on every render.
  const first = Math.floor(top)
  const visible: { n: number; line: Line }[] = []
  if (root) {
    for (let n = first; n < Math.min(total, first + perPage + 2); n++) {
      const line = resolve(root, n, 0, true, null)
      if (line) visible.push({ n, line })
    }
  }

  // Fetch pages for children that are on screen but not loaded yet.
  useEffect(() => {
    for (const { line } of visible) {
      if (line.type === 'child' && !line.parent.child(line.index)) load(line.parent, Math.floor(line.index / PAGE))
      // Containers opened by "Expand all" (or reloaded after an edit) fetch their first page once on screen.
      if (line.type === 'open' && !line.o.loaded) load(line.o, 0)
    }
  })

  const toggle = useCallback(
    (parent: Open, index: number) => {
      if (parent.open.has(index)) {
        parent.open.delete(index)
      } else {
        const node = parent.child(index)
        if (!node || !isContainer(node)) return
        const o = new Open(node, [...parent.path, index], true)
        parent.open.set(index, o)
        load(o, 0)
      }
      redraw()
    },
    [load],
  )

  const expandAll = useCallback(() => {
    if (!root) return
    expandDeep(root)
    if (!root.loaded) load(root, 0)
    redraw()
  }, [root, load])

  const collapseAll = useCallback(() => {
    if (!root) return
    root.expandAll = false
    root.open.clear()
    setSelected(0)
    setTop(0)
    redraw()
  }, [root])

  /** Collapses the container that line `n` opens or closes. */
  const collapse = useCallback(
    (line: Line) => {
      if (line.type === 'child') return
      const parent = findParent(root, line.o)
      if (!parent) return
      for (const [k, v] of parent.open) if (v === line.o) parent.open.delete(k)
      redraw()
    },
    [root],
  )

  const copy = useCallback(
    async (line: Line) => {
      const { node, path } = target(line)
      if (!node || node.kind === 'lines' || node.kind === 'blank') return
      try {
        await navigator.clipboard.writeText(await api.jsonRaw(id, path))
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      } catch (e) {
        onError(errorText(e))
      }
    },
    [id, onError],
  )

  const findOpen = useCallback(
    (path: number[]): Open | null => {
      let o: Open | null = root
      for (const i of path) o = o?.open.get(i) ?? null
      return o
    },
    [root],
  )

  /** Sends an edit. Expanded nodes after an insert or delete move with their data. */
  const commit = useCallback(
    async (edit: JsonEdit, shift?: { parent: number[]; at: number; delta: number }) => {
      try {
        const view = await api.jsonEdit(id, edit)
        const parent = shift && findOpen(shift.parent)
        if (shift && parent) shiftOpen(parent, shift.at, shift.delta)
        // The version bump reloads the tree.
        onView(view)
        return true
      } catch (e) {
        onError(errorText(e))
        return false
      }
    },
    [id, findOpen, onView, onError],
  )

  const startEditValue = useCallback(
    async (line: Line) => {
      if (!editable) return
      const { node, path } = target(line)
      if (!node || node.kind === 'lines' || path.length === 0) return
      const container = isContainer(node)
      if (container && node.size > MAX_EDIT_TEXT) {
        onError('This value is too large to edit as text; edit the items inside it instead.')
        return
      }
      let text = node.text
      if (container || node.size > text.length) {
        try {
          text = await api.jsonRaw(id, path)
        } catch (e) {
          onError(errorText(e))
          return
        }
      }
      setEditing({ kind: 'value', path, text, multiline: container || text.includes('\n') })
    },
    [editable, id, onError],
  )

  const startRename = useCallback(
    (line: Line) => {
      if (!editable) return
      const { node, path } = target(line)
      if (!node || node.key === null || path.length === 0) return
      setEditing({ kind: 'key', path, text: node.key })
    },
    [editable],
  )

  /** Adds inside the container on this line, or after the value on it. */
  const startAdd = useCallback(
    (line: Line) => {
      if (!editable) return
      const { node, path, parent, index } = target(line)
      if (!node) return
      if (isContainer(node) || node.kind === 'lines') {
        setEditing({ kind: 'add', parent: path, index: END, object: node.kind === 'object', key: '', text: '' })
      } else if (parent && index !== null) {
        setEditing({ kind: 'add', parent: parent.path, index: index + 1, object: parent.node.kind === 'object', key: '', text: '' })
      }
    },
    [editable],
  )

  const remove = useCallback(
    (line: Line) => {
      if (!editable) return
      const { path } = target(line)
      if (path.length === 0) return
      commit({ op: 'delete', path }, { parent: path.slice(0, -1), at: path[path.length - 1], delta: -1 })
    },
    [editable, commit],
  )

  const closeEditor = useCallback(() => {
    setEditing(null)
    body.current?.focus()
  }, [])

  const saveEditing = useCallback(async () => {
    if (!editing) return
    let ok: boolean
    if (editing.kind === 'value') ok = await commit({ op: 'set', path: editing.path, text: editing.text })
    else if (editing.kind === 'key') ok = await commit({ op: 'rename', path: editing.path, key: editing.text.trim() })
    else {
      if (editing.object && !editing.key.trim()) {
        onError('Enter a key for the new member.')
        return
      }
      ok = await commit(
        {
          op: 'insert',
          parent: editing.parent,
          index: editing.index,
          key: editing.object ? editing.key.trim() : null,
          text: editing.text.trim() ? editing.text : 'null',
        },
        editing.index === END ? undefined : { parent: editing.parent, at: editing.index, delta: 1 },
      )
    }
    if (ok) closeEditor()
  }, [editing, commit, closeEditor, onError])

  const select = useCallback(
    (n: number) => {
      const s = Math.min(Math.max(0, n), Math.max(0, total - 1))
      setSelected(s)
      setTop((t) => (s < t ? s : s >= t + perPage ? clampTop(s - perPage + 1) : t))
    },
    [total, perPage, clampTop],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!root || editing) return
    const line = resolve(root, selected, 0, true, null)
    const node = line ? target(line).node : undefined
    const keys: Record<string, () => void> = {
      ArrowDown: () => select(selected + 1),
      ArrowUp: () => select(selected - 1),
      PageDown: () => select(selected + perPage),
      PageUp: () => select(selected - perPage),
      Home: () => select(0),
      End: () => select(total - 1),
      ArrowRight: () => {
        if (line?.type === 'child' && !line.parent.open.has(line.index)) toggle(line.parent, line.index)
      },
      ArrowLeft: () => line && collapse(line),
      Enter: () => {
        // Enter edits a value; on a container it folds and unfolds.
        if (line?.type === 'child' && node && !isContainer(node)) startEditValue(line)
        else if (line?.type === 'child') toggle(line.parent, line.index)
        else if (line) collapse(line)
      },
      F2: () => line && startRename(line),
    }
    // `*` expands everything under the selected line, as in most tree views.
    if (e.key === '*' && line) {
      e.preventDefault()
      if (line.type === 'child') {
        if (!node || !isContainer(node)) return
        if (!line.parent.open.has(line.index)) toggle(line.parent, line.index)
        expandDeep(line.parent.open.get(line.index)!)
      } else if (line.type === 'open') expandDeep(line.o)
      redraw()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      if (line) copy(line)
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
      // Handled here so the table's "delete rows" shortcut doesn't also fire.
      e.preventDefault()
      e.stopPropagation()
      if (line && line.type !== 'close') remove(line)
      return
    }
    const action = keys[e.key]
    if (action) {
      e.preventDefault()
      action()
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      async reveal(row: number) {
        if (!root) return
        let target = root
        const key = root.node.kind === 'lines' ? null : rowsKey(detail)
        if (key !== null) {
          // Rows live under a key of the root object, like `data`.
          await load(root, 0)
          const index = root.pages.get(0)?.findIndex((c) => c.key === key) ?? -1
          if (index < 0) return
          if (!root.open.has(index)) toggle(root, index)
          target = root.open.get(index)!
        }
        await load(target, Math.floor(row / PAGE))
        const line = (target === root ? 0 : (openLine(root, target) ?? 0)) + childLine(target, row)
        setSelected(line)
        setTop(clampTop(line - Math.floor(perPage / 2)))
        redraw()
      },
      expandAll,
      collapseAll,
    }),
    [root, detail, load, toggle, clampTop, perPage, expandAll, collapseAll],
  )

  // Scrollbar: thumb size and position mirror the virtual scroll.
  const trackHeight = track.current?.clientHeight ?? height
  const thumb = total > perPage ? Math.max(28, (trackHeight * perPage) / total) : 0
  const thumbTop = maxTop > 0 ? (top / maxTop) * (trackHeight - thumb) : 0
  const drag = useRef<{ y: number; top: number } | null>(null)

  return (
    <div className="jtree">
      <div className="jtree-bar">
        <button className="btn small" onClick={expandAll} title="Expand every object and array (*)">
          Expand all
        </button>
        <button className="btn small" onClick={collapseAll}>
          Collapse all
        </button>
        <span className="hint">
          {editable ? 'Double-click a value or key to edit it. ' : ''}Nested items open as you scroll to them.
        </span>
      </div>
      <div className="jtree-main">
        <div ref={body} className="jtree-body" tabIndex={0} role="tree" aria-label="JSON" onKeyDown={onKeyDown}>
          <div
            className="jtree-lines"
            style={{ transform: `translateY(${-(top - first) * LINE}px)`, '--jline-height': `${LINE}px` } as CSSProperties}
          >
            {visible.map(({ n, line }) => {
              const t = target(line)
              const inline =
                editing && editing.kind !== 'add' && line.type !== 'close' && samePath(editing.path, t.path) ? editing : null
              const canEdit = editable && line.type !== 'close' && t.path.length > 0
              return (
                <LineView
                  key={n}
                  line={line}
                  node={t.node}
                  selected={n === selected}
                  editable={canEdit}
                  canAdd={editable && line.type !== 'close' && !!t.node && (isContainer(t.node) || t.node.kind === 'lines' || t.parent !== null)}
                  editing={inline}
                  expanded={line.type !== 'child' || line.parent.open.has(line.index)}
                  onClick={() => setSelected(n)}
                  onToggle={() => (line.type === 'child' ? toggle(line.parent, line.index) : collapse(line))}
                  onEditValue={() => startEditValue(line)}
                  onRename={() => startRename(line)}
                  onAdd={() => startAdd(line)}
                  onDelete={() => remove(line)}
                  onEditText={(text) => setEditing((e) => (e && e.kind !== 'add' ? { ...e, text } : e))}
                  onSave={saveEditing}
                  onCancel={closeEditor}
                />
              )
            })}
          </div>
        </div>
        {thumb > 0 && (
          <div
            ref={track}
            className="jtree-track"
            onPointerDown={(e) => {
              if (e.target !== e.currentTarget) return
              const rect = e.currentTarget.getBoundingClientRect()
              setTop(clampTop(((e.clientY - rect.top - thumb / 2) / (rect.height - thumb)) * maxTop))
            }}
          >
            <div
              className="jtree-thumb"
              style={{ height: thumb, transform: `translateY(${thumbTop}px)` }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                drag.current = { y: e.clientY, top }
              }}
              onPointerMove={(e) => {
                if (!drag.current) return
                const dy = e.clientY - drag.current.y
                setTop(clampTop(drag.current.top + (dy / Math.max(1, trackHeight - thumb)) * maxTop))
              }}
              onPointerUp={() => (drag.current = null)}
            />
          </div>
        )}
      </div>
      {editing?.kind === 'add' && <AddForm editing={editing} onChange={setEditing} onSave={saveEditing} onCancel={closeEditor} />}
      {editing?.kind === 'value' && editing.multiline && (
        <div className="jtree-editor" role="dialog" aria-label="Edit value">
          <span className="popover-title">Edit value</span>
          <textarea
            autoFocus
            spellCheck={false}
            rows={12}
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                saveEditing()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeEditor()
              }
            }}
          />
          <div className="popover-actions">
            <span className="hint grow">Valid JSON is saved as is; other text becomes a string. ⌘↵ saves.</span>
            <button className="btn" onClick={closeEditor}>
              Cancel
            </button>
            <button className="btn primary" onClick={saveEditing}>
              Save
            </button>
          </div>
        </div>
      )}
      {copied && <span className="status-pill jtree-copied">Copied</span>}
    </div>
  )
})

function findParent(o: Open | null, target: Open): Open | null {
  if (!o) return null
  for (const c of o.open.values()) {
    if (c === target) return o
    const hit = findParent(c, target)
    if (hit) return hit
  }
  return null
}

/** Form for a new member (key and value) or item (value). */
function AddForm({
  editing,
  onChange,
  onSave,
  onCancel,
}: {
  editing: Extract<Editing, { kind: 'add' }>
  onChange: (e: Editing) => void
  onSave: () => void
  onCancel: () => void
}) {
  const keyDown = (e: React.KeyboardEvent) => {
    const inArea = e.target instanceof HTMLTextAreaElement
    if (e.key === 'Enter' && (!inArea || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <div className="jtree-editor" role="dialog" aria-label="Add" onKeyDown={keyDown}>
      <span className="popover-title">{editing.object ? 'Add a member' : 'Add an item'}</span>
      {editing.object && (
        <input autoFocus placeholder="Key" spellCheck={false} value={editing.key} onChange={(e) => onChange({ ...editing, key: e.target.value })} />
      )}
      <textarea
        autoFocus={!editing.object}
        rows={3}
        placeholder={'Value, e.g. "text", 42, true, null, {} or []'}
        spellCheck={false}
        value={editing.text}
        onChange={(e) => onChange({ ...editing, text: e.target.value })}
      />
      <div className="popover-actions">
        <span className="hint grow">Valid JSON is saved as is; other text becomes a string.</span>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={onSave}>
          Add
        </button>
      </div>
    </div>
  )
}

function InlineInput({ value, onChange, onSave, onCancel }: { value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <input
      className="jline-input"
      autoFocus
      spellCheck={false}
      value={value}
      size={Math.max(4, Math.min(80, value.length + 1))}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          onSave()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

interface LineProps {
  line: Line
  node: JsonNode | undefined
  selected: boolean
  editable: boolean
  canAdd: boolean
  editing: Extract<Editing, { kind: 'value' | 'key' }> | null
  expanded: boolean
  onClick: () => void
  onToggle: () => void
  onEditValue: () => void
  onRename: () => void
  onAdd: () => void
  onDelete: () => void
  onEditText: (text: string) => void
  onSave: () => void
  onCancel: () => void
}

function LineView(p: LineProps) {
  const { line, node, selected, expanded, editing } = p
  const comma = !line.last && <span className="j-punct">,</span>
  // Array items and JSON Lines show their position in the gutter.
  const parentKind = line.type === 'child' ? line.parent.node.kind : null
  const gutter =
    line.type === 'child' && (parentKind === 'array' || parentKind === 'lines')
      ? formatCount(parentKind === 'lines' ? line.index + 1 : line.index)
      : line.type === 'open' && line.index !== null && node?.key === null
        ? formatCount(line.index)
        : ''
  const input = (e: NonNullable<LineProps['editing']>) => (
    <InlineInput value={e.text} onChange={p.onEditText} onSave={p.onSave} onCancel={p.onCancel} />
  )

  let content: React.ReactNode
  if (!node) {
    content = <span className="j-muted">…</span>
  } else if (line.type === 'close') {
    content = (
      <>
        <span className="j-punct">{node.kind === 'object' ? '}' : ']'}</span>
        {comma}
      </>
    )
  } else {
    const key = node.key !== null && (
      <>
        {editing?.kind === 'key' ? (
          input(editing)
        ) : (
          <span className="j-key" onDoubleClick={p.editable ? p.onRename : undefined}>
            {JSON.stringify(node.key)}
          </span>
        )}
        <span className="j-punct">: </span>
      </>
    )
    const [open, close] = node.kind === 'object' ? ['{', '}'] : ['[', ']']
    content = (
      <>
        {key}
        {isContainer(node) && line.type === 'open' && <span className="j-punct">{open}</span>}
        {isContainer(node) && line.type === 'child' && (
          <>
            <span className="j-punct" onDoubleClick={p.editable ? p.onEditValue : undefined}>
              {open}…{close}
            </span>
            {comma}
            <span className="j-muted"> {summary(node)}</span>
          </>
        )}
        {!isContainer(node) &&
          (editing?.kind === 'value' && !editing.multiline ? (
            input(editing)
          ) : (
            <>
              <span className={`j-${node.kind}`} onDoubleClick={p.editable ? p.onEditValue : undefined}>
                {node.text}
              </span>
              {comma}
            </>
          ))}
      </>
    )
  }

  const foldable = node && isContainer(node) && line.type !== 'close' && !(line.type === 'open' && line.index === null && line.depth === 0)
  return (
    <div className={`jline${selected ? ' selected' : ''}`} onMouseDown={p.onClick} role="treeitem" aria-expanded={foldable ? expanded : undefined}>
      <span className="jline-gutter">{gutter}</span>
      <span className="jline-indent" style={{ width: line.depth * INDENT }} />
      <span className="jline-fold">
        {foldable && (
          <button
            className={`jline-arrow${expanded ? ' open' : ''}`}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={p.onToggle}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        )}
      </span>
      <span className="jline-text">{content}</span>
      {(p.canAdd || p.editable) && !editing && (
        <span className="jline-actions">
          {p.canAdd && (
            <button
              title={node && (isContainer(node) || node.kind === 'lines') ? 'Add inside' : 'Add after'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={p.onAdd}
            >
              <IconPlus />
            </button>
          )}
          {p.editable && (
            <button title="Delete (⌘⌫)" onMouseDown={(e) => e.stopPropagation()} onClick={p.onDelete}>
              <IconTrash />
            </button>
          )}
        </span>
      )}
    </div>
  )
}
