# BigView: developer guide

[← Back to README](../README.md) · [User guide](user.md)

## Build and install

Needs Node 22 and Rust (stable). Builds on macOS and Windows.

```bash
cd bigview
npm install
npm run tauri build                            # macOS: .app and .dmg · Windows: installer
cp -R src-tauri/target/release/bundle/macos/BigView.app /Applications/   # macOS
```

```bash
npm run tauri dev   # run with hot reload
npm run build       # TypeScript check and the UI bundle alone
```

CI (`../.github/workflows/bigview.yml`) builds the macOS `.dmg` and the Windows installer on every
push that changes `bigview/`; tagging `v*` builds every app in this repo and publishes one release
(`release.yml`).

## Code layout

The UI is React 18 + Vite (`src/`), with [Glide Data Grid](https://grid.glideapps.com/) drawing
the table on a canvas. It talks to Rust through Tauri commands, wrapped in `src/lib/api.ts`.
Theme tokens are shared with Agentic Browser (warm paper tones, a clay accent).

| File | What it is |
|---|---|
| `src/App.tsx` | Tabs, toolbar, menus, keyboard shortcuts, status bar, saving |
| `src/components/StartPage.tsx` | Openers per file type and the recent files list |
| `src/components/DataView.tsx` | The table: cells from the row cache, editing, column menu, type detection, freezing |
| `src/components/JsonView.tsx` | The JSON tree for non-tabular JSON |
| `src/components/FilterBar.tsx`, `FilterEditor.tsx` | Sort and filter chips; the filter popover |
| `src/components/StatsPanel.tsx` | Column statistics side panel |
| `src/components/FindBar.tsx`, `GoToRow.tsx` | Find and replace; go to row |
| `src/components/CommandPalette.tsx` | ⌘K: every menu action by name |
| `src/components/SaveAs.tsx`, `FileOptions.tsx` | Format picker for Save as / Export; header, delimiter and encoding |
| `src/components/Settings.tsx` | The Settings tab |
| `src/lib/rowCache.ts` | Pages of 256 rows fetched on demand; an LRU of 80 pages |
| `src/lib/settings.ts` | Settings and recent files (local storage) |
| `src/lib/gridTheme.ts` | Grid colours from the CSS tokens, for light and dark |

| File | What it is |
|---|---|
| `src-tauri/src/commands.rs` | Tauri commands: open, rows, edits, undo, save, search, view, stats, file info |
| `src-tauri/src/core/source.rs` | A readable file: row count, columns and random access to rows |
| `src-tauri/src/core/index.rs` | Byte offsets of row starts, built by a background scan |
| `src-tauri/src/core/session.rs` | One open file: the source plus edits, undo / redo and saving |
| `src-tauri/src/core/edits.rs` | Cell, row and column edits layered over the source |
| `src-tauri/src/core/view.rs`, `sort.rs`, `filter.rs` | Sorted and filtered views as a display order over the rows |
| `src-tauri/src/core/search.rs` | Find and replace across the whole file |
| `src-tauri/src/core/stats.rs` | Column statistics and selection totals in one parallel pass |
| `src-tauri/src/core/export.rs` | Save as another format, streaming rows with edits applied |
| `src-tauri/src/formats/` | CSV, JSON / JSON Lines (and the JSON tree), Excel; text encodings |

## How it works

- **Nothing is loaded whole.** Text files are memory-mapped and a background scan records where
  each row starts (`index.rs`), emitting `index-progress` events; the grid asks for rows by number
  and gets them from those offsets. Excel sheets are read once into a cache file in the same way.
- **Edits** sit in a layer over the untouched source (`edits.rs`), so undo is cheap and the file
  isn't touched until you save. Saving streams every row through that layer to a temporary file,
  then replaces the original.
- **Sort, filter, stats and search** run on all cores (`rayon`) over every row, report progress
  (`task-progress`) and can be cancelled. A sorted or filtered view is a display order of row
  numbers, so it costs memory per row, not per cell.
- **Encodings:** non-UTF-8 text is converted once into `bigview-cache` in the temp folder
  (`formats/text.rs`); files there from processes that are no longer running are deleted at
  startup.
- **Windows:** memory-mapped files can't be replaced while mapped, so saving over an open file
  unmaps it first (`core/session.rs`); Excel reads use `seek_read`.

## Testing with big files

`fixtures/` is git-ignored. Generate test files (1 GB each by default) with:

```bash
cd src-tauri
cargo run --release --example gen_fixtures -- ../fixtures 1024 csv json jsonl wrapped xlsx
```

Headless checks and benchmarks, each run with `cargo run --release --example <name> -- <args>`:

| Example | What it checks |
|---|---|
| `bench_csv <file>` | Index, random reads, edits, save and reopen on a big file (any format) |
| `bench_search <file>` | Find speed, and that it sees unsaved edits |
| `bench_sort <file>` | Sort, filter and column stats speed and results |
| `bench_xlsx <file.xlsx>` | Excel sheet reading speed |
| `export_check <dir>` | Save as conversion, view export, sheet splitting |
| `format_check <dir>` | Column operations and open options on small files |
| `json_edit_check <dir>` | Editing JSON through the tree and the table, then saving |
