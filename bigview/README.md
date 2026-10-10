# BigView

A desktop viewer and editor for very large data files: CSV / TSV, JSON / JSON Lines and Excel workbooks, from a few rows to gigabytes. Files are indexed in the background by a Rust backend (Tauri 2), and only the rows on screen are loaded into the window, so files of any size open in seconds and scroll smoothly.

## Features

- **Open anything big**: CSV, TSV, JSON, JSONL / NDJSON, XLSX / XLSM. Drop files on the window or pick a type from the start page.
- **Spreadsheet-style grid**: numbers right-aligned, column types detected, columns sized to their contents, hover and optional striped rows, frozen columns.
- **Sort and filter** across every row, with filters shown as chips you can edit or remove.
- **Column statistics**: count, empty, distinct, min / max / sum / average and the most common values (click one to filter by it).
- **Find and replace** across the whole file, plus **Go to row**.
- **Edit** cells, insert and delete rows and columns, with undo / redo.
- **Save, Save as, Export current view** to CSV, JSON, JSONL or Excel (rows split across sheets past Excel's limit).
- **JSON tree view** for non-tabular JSON.
- **Command palette** (⌘K / Ctrl+K) lists every action with its shortcut.
- Light and dark themes, two row densities.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Command palette | ⌘K | Ctrl+K |
| Open file | ⌘O | Ctrl+O |
| Save / Save as | ⌘S / ⌘⇧S | Ctrl+S / Ctrl+Shift+S |
| Find and replace | ⌘F | Ctrl+F |
| Go to row | ⌘G | Ctrl+G |
| Undo / Redo | ⌘Z / ⌘⇧Z | Ctrl+Z / Ctrl+Y |
| Insert row below / Delete rows | ⌘↵ / ⌘⌫ | Ctrl+Enter / Ctrl+Backspace |
| Next / previous tab | ⌃Tab / ⌃⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Settings | ⌘, | Ctrl+, |

## Development

Requires Node.js and a Rust toolchain ([Tauri prerequisites](https://tauri.app/start/prerequisites/)).

```sh
npm install
npm run tauri dev     # run the app
npm run tauri build   # build an installer
```

Sample files for testing live in `fixtures/`.

Stack: Tauri 2 (Rust) · React 18 · TypeScript · Vite · [Glide Data Grid](https://grid.glideapps.com/).
