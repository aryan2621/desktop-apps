# BigView: user guide

[← Back to README](../README.md) · [Developer guide](dev.md)

- [Install](#install) · [Opening files](#opening-files) · [The table](#the-table) · [Sort and filter](#sort-and-filter)
- [Column statistics](#column-statistics) · [Find and replace](#find-and-replace) · [Editing](#editing)
- [Saving and exporting](#saving-and-exporting) · [JSON view](#json-view) · [Settings](#settings)
- [Keyboard shortcuts](#keyboard-shortcuts) · [Your data](#your-data) · [Troubleshooting](#troubleshooting)

## Install

- **macOS:** download [`BigView_0.1.0_aarch64.dmg`](https://github.com/aryan2621/dev-tools/releases/latest/download/BigView_0.1.0_aarch64.dmg)
  (macOS 10.13 or later, Apple silicon), open it and drag **BigView** into **Applications**.
- **Windows:** download and run [`BigView_0.1.0_x64-setup.exe`](https://github.com/aryan2621/dev-tools/releases/latest/download/BigView_0.1.0_x64-setup.exe)
  (Windows 10 or later).

**"Apple could not verify BigView is free of malware":** BigView isn't signed with a paid Apple
Developer certificate, so macOS warns you the first time. Click **Done**, open **System Settings →
Privacy & Security**, scroll down, click **Open Anyway** next to BigView and confirm. If macOS says
BigView **"is damaged and can't be opened"**, run this once in Terminal and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/BigView.app
```

**Windows SmartScreen** may say it protected your PC: click **More info → Run anyway**.

## Opening files

| Type | Extensions |
|---|---|
| Excel | `.xlsx`, `.xlsm` |
| CSV | `.csv`, `.tsv`, `.txt` |
| JSON | `.json` (an array of records, or any JSON), `.jsonl`, `.ndjson` |

- The **start page** has one button per type, **Open any file…**, and your **recent files** with
  their size and when they changed. Files that were moved or deleted show **File not found**.
- Remove recent files one at a time (the **✕** on hover) or tick several and **Remove**. **Remove
  missing** clears the ones that are gone. This only edits the list; files stay on disk.
- **Drop files** anywhere in the window. Each file opens in its own tab.
- Big files open right away: rows appear while the rest is read. The status bar shows
  **Indexing 42%**. You can scroll and edit meanwhile; saving unlocks when reading finishes.
- **How a file is read:** click the file pill on the right of the toolbar (e.g. `CSV · 1.0 GB`)
  to change the **header row**, **delimiter** (comma, semicolon, tab, pipe) or **encoding**
  (UTF-8, UTF-16, Windows-1252 and others). The file reopens with the new settings.
- **Excel workbooks** with several sheets show sheet tabs at the bottom.

## The table

- Numbers are right-aligned, and each header shows whether the column holds numbers, dates or
  text (judged from the first rows).
- Columns are sized to their contents. Drag a header edge to resize, **double-click** it to fit,
  or use **Fit width to contents** in the column menu.
- **Freeze columns up to here** (column menu) keeps columns on the left while you scroll sideways.
- Select cells, rows (click the row numbers) or columns; the status bar shows **Count**, **Sum**
  and **Average** of the selection.

## Sort and filter

Open a column's menu (the arrow in its header, or right-click the header):

- **Sort A → Z / Z → A.** Once a column is sorted, **Then by this** adds another sort key.
- **Filter…**: contains, doesn't contain, is, starts with, matches (regular expression),
  =, ≠, >, <, between, is empty, is not empty, or **is one of** a list of values.
- The **Filter** button in the toolbar filters the column you're on.

Active sorts and filters show as **chips** under the toolbar: click one to edit it, **✕** to
remove it, **Clear all** to go back to the file's order. **Export…** saves just these rows.
Sorting and filtering read every row, so on big files they show progress and can be cancelled
with **Esc**.

While a sort or filter is on, inserting or deleting rows and columns is paused (clear it first).
Cells you edit stay where they are until you **Re-apply**.

## Column statistics

**Column statistics** (column menu) opens a side panel: rows, empty cells, distinct values, and
for numbers the min, max, sum and average (for text, the first and last A–Z). **Most common**
lists the top values with bars; click one to filter by it.

## Find and replace

**⌘F** (Ctrl+F) searches every row, including unsaved edits. You can match case, use a regular
expression, or search one column instead of all. **Enter** / **⇧Enter** move between matches;
**Replace** and **Replace all** (⌘↵ / Ctrl+Enter) work in the table.

## Editing

- Double-click a cell (or start typing) to edit it. **Delete** clears the selected cells. Paste
  from Excel, Google Sheets or text fills cells from the one you're on.
- **⌘↵** (Ctrl+Enter) inserts a row below; **⌘⌫** (Ctrl+Backspace) deletes the selected rows.
- The column menu renames, inserts and deletes columns; drag a header to move a column.
- **Undo** and **Redo** cover every edit. A dot on the tab means unsaved changes, and BigView asks
  before closing a tab or quitting with them.

## Saving and exporting

- **Save** (⌘S / Ctrl+S) writes over the file in its own format.
- **Save as…** (⌘⇧S / Ctrl+Shift+S) picks a format (CSV, JSON, JSON Lines or Excel) and a place.
  The tab then shows the new file.
- **Export current view…** saves only the sorted and filtered rows, in that order, and leaves the
  tab as it is.
- Excel holds 1,048,575 rows per sheet, so bigger exports are split across Sheet1, Sheet2 and so
  on. Saving over a workbook keeps every sheet's values but drops formatting, formulas (their
  results stay), charts and macros; BigView asks first.
- **Esc** cancels a save in progress and deletes the partly written file.

## JSON view

JSON that isn't a list of records (settings files, nested objects) opens as a **tree**. Lists of
records open as a table. The **Table / JSON** switch in the toolbar changes the view. In the tree,
expand and collapse nodes (**Expand all / Collapse all** in the ⋮ menu) and edit values in place.

## Settings

**⌘,** (Ctrl+,) opens Settings in a tab:

- **Appearance:** theme (follow system, light, dark), row density (comfortable or compact), row
  shading (plain or striped).
- **Opening files:** whether JSON opens as a table, as JSON, or automatically.
- **Recent files:** open or remove them.

## Keyboard shortcuts

| Action | macOS | Windows |
|---|---|---|
| All commands | ⌘K | Ctrl+K |
| Open file | ⌘O | Ctrl+O |
| Save / Save as | ⌘S / ⌘⇧S | Ctrl+S / Ctrl+Shift+S |
| Find and replace | ⌘F | Ctrl+F |
| Go to row | ⌘G | Ctrl+G |
| Undo / Redo | ⌘Z / ⌘⇧Z | Ctrl+Z / Ctrl+Y |
| Insert row below / Delete rows | ⌘↵ / ⌘⌫ | Ctrl+Enter / Ctrl+Backspace |
| Close tab | ⌘W | Ctrl+W |
| Next / previous tab | ⌃Tab / ⌃⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to tab 1–9 | ⌘1–⌘9 | Ctrl+1–Ctrl+9 |
| Settings | ⌘, | Ctrl+, |
| Cancel a sort, filter or save | Esc | Esc |

## Your data

- Everything happens on your computer. BigView makes no network requests and has no analytics.
- Files are read in place. Unsaved edits are kept in memory and in temporary files in a
  `bigview-cache` folder in your system's temp folder. Files left there by an earlier run are
  deleted the next time BigView starts.
- Settings and the recent files list are stored in the app's own storage on this computer.

## Troubleshooting

- **Characters look wrong (Ã© instead of é):** click the file pill and pick another **encoding**,
  e.g. Windows-1252 for older Excel CSVs.
- **Everything is in one column:** pick the right **delimiter** in the file pill.
- **The first row shows as data (or a data row as headers):** toggle **First row is the header**.
- **Save is greyed out:** the file is still being read (see the status bar), or it couldn't be read
  completely and is read-only.
