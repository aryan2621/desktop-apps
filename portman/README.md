# PortMan

**Own your ports. See what's running on every port, and stop it in one click.**

<!-- DEMO VIDEO: paste the https://github.com/user-attachments/assets/... link on the next line -->

- **See** every open port: the process, its PID, user, state and what service it is (PostgreSQL,
  Redis, Vite…), live.
- **Find** anything by port, process name, PID or command line. System ports are hidden by default.
- **Stop** a process, or several at once. PortMan also stops the LaunchAgent or systemd service
  that would restart it.
- **Open** a local web server in your browser straight from the list.
- A **desktop app** (macOS, Windows, Linux) and a **command line tool** with a live terminal view.

**[⬇ Download for macOS](https://github.com/aryan2621/dev-tools/releases/latest/download/PortMan_1.0.0_aarch64.dmg)**
· [Windows](https://github.com/aryan2621/dev-tools/releases/latest/download/PortMan_1.0.0_x64-setup.exe)
· [Linux](https://github.com/aryan2621/dev-tools/releases/latest/download/port-man_1.0.0_amd64.AppImage)
· [CLI and all downloads](https://github.com/aryan2621/dev-tools/releases/latest)

📖 **[User guide](docs/user.md)** — the app, the CLI, settings and troubleshooting
🛠 **[Developer guide](docs/dev.md)** — build from source, code layout, how it works

## Install

**macOS:** open the `.dmg`, drag **PortMan** into **Applications**, and open it.
- If macOS says **"Apple could not verify PortMan is free of malware"**: click **Done**, go to
  **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. (PortMan isn't
  signed with a paid Apple certificate; that's the only reason for the warning.)
- If it says PortMan **"is damaged"**, run this once in Terminal and open it again:
  ```bash
  xattr -dr com.apple.quarantine /Applications/PortMan.app
  ```

**Windows:** run `PortMan_1.0.0_x64-setup.exe` (or the `.msi`). If Windows shows **"Windows
protected your PC"**, click **More info → Run anyway**.

**Linux:** `chmod +x port-man_1.0.0_amd64.AppImage && ./port-man_1.0.0_amd64.AppImage`, or
`sudo apt install ./port-man_1.0.0_amd64.deb`.

**CLI:** download `portman-<os>-<arch>` from the [releases page](https://github.com/aryan2621/dev-tools/releases/latest), then:
```bash
chmod +x portman-darwin-arm64
xattr -d com.apple.quarantine portman-darwin-arm64   # macOS only
sudo mv portman-darwin-arm64 /usr/local/bin/portman
```

## Quick start

| App | CLI |
|---|---|
| Type in the search box: `3000`, `node`, a PID… | `portman list --proc node` |
| Select rows, click **Kill** | `portman kill 3000` |
| Click a row's **Info** | `portman info 3000` |
| Open a web port in the browser | `portman watch` (live view, `k` to kill, `q` to quit) |

## Build from source

```bash
cd portman/cli && go build -o portman .                       # CLI
cd portman/gui && npm install && npm run tauri build          # desktop app (needs uv for the core)
```

Details in the [developer guide](docs/dev.md).
