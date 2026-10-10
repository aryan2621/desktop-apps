# BigView

**Open CSV, JSON and Excel files of any size. Gigabyte files open in seconds and scroll smoothly.**

<!-- DEMO VIDEO: paste the https://github.com/user-attachments/assets/... link on the next line -->

- **Open** CSV, TSV, JSON, JSON Lines and Excel (.xlsx, .xlsm). Rows show while the file is still
  being read, and only the rows on screen are ever loaded, so a 1 GB file uses little memory.
- **Explore**: sort by several columns, filter with chips you can edit, see column statistics and
  the most common values, find and replace across every row, go to any row.
- **Edit** cells, rows and columns with undo and redo, then **save** or **export** the current view
  to CSV, JSON, JSON Lines or Excel.
- **Read comfortably**: numbers line up on the right, column types and widths are detected,
  rows highlight on hover, columns can be frozen, and non-tabular JSON opens as a tree.

**[⬇ Download for macOS](https://github.com/aryan2621/dev-tools/releases/latest/download/BigView_0.1.0_aarch64.dmg)**
· [Windows](https://github.com/aryan2621/dev-tools/releases/latest/download/BigView_0.1.0_x64-setup.exe)
· macOS 10.13+ (Apple silicon), Windows 10+ · [all downloads](https://github.com/aryan2621/dev-tools/releases/latest)

📖 **[User guide](docs/user.md)**: opening files, the table, sort and filter, editing, saving, shortcuts
🛠 **[Developer guide](docs/dev.md)**: build from source, code layout, how it works

## Install

**macOS**

1. Open the `.dmg` and drag **BigView** into **Applications**, then open it.
2. If macOS says **"Apple could not verify BigView is free of malware"**: click **Done**, go to
   **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. (BigView isn't
   signed with a paid Apple certificate; that's the only reason for the warning.)
3. If it says BigView **"is damaged"**, run this once in Terminal and open it again:
   ```bash
   xattr -dr com.apple.quarantine /Applications/BigView.app
   ```

**Windows**

Run `BigView_0.1.0_x64-setup.exe`. If Windows SmartScreen says it **protected your PC**, click
**More info → Run anyway** (the installer isn't code-signed).

## Quick start

1. Pick **Excel**, **CSV** or **JSON** on the start page, or drop files anywhere in the window.
2. Click a column header's arrow for **Sort**, **Filter…** and **Column statistics**.
3. Press **⌘F** (Ctrl+F) to find and replace, **⌘G** (Ctrl+G) to go to a row, and **⌘K** (Ctrl+K)
   for every command.
4. Edit a cell by double-clicking it; **⌘S** (Ctrl+S) saves, **⌘⇧S** (Ctrl+Shift+S) saves a copy
   in any format.

## Build from source

```bash
cd bigview && npm install && npm run tauri build
```

Needs Node and Rust. Details in the [developer guide](docs/dev.md).
