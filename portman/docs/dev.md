# PortMan: developer guide

[← Back to README](../README.md) · [User guide](user.md)

PortMan is two independent programs that read ports the same way:

| | Language | Where | Role |
|---|---|---|---|
| **CLI** | Go (`gopsutil`, `cobra`, Bubble Tea for `watch`) | `cli/` | Single static binary per platform |
| **Desktop app** | Tauri 1 + React 18 + Vite | `gui/` | The window |
| **Core** | Python (`psutil`) | `core/`, `core_entry.py` | Ports, kills, service detection for the app, over JSON-RPC on stdin/stdout |

## Build the CLI

Needs Go.

```bash
cd portman/cli
go build -o portman .
./portman list

# Other platforms
GOOS=darwin  GOARCH=arm64 go build -o portman-darwin-arm64 .
GOOS=linux   GOARCH=amd64 go build -o portman-linux-amd64 .
GOOS=windows GOARCH=amd64 go build -o portman-windows-amd64.exe .
```

## Build the desktop app

Needs Node 22, Rust, and [uv](https://docs.astral.sh/uv/) (for the Python core). On Linux also
Tauri 1's system libraries (`libwebkit2gtk-4.0-dev` and friends; see the CI workflow).

```bash
cd portman/gui
npm install
npm run tauri dev                  # run with hot reload
npm run tauri build                # build the installers
```

`npm run tauri build` first runs `scripts/build-core.sh`, which turns the Python core into one
executable with PyInstaller (Python and psutil included) at
`gui/src-tauri/binaries/portman-core-<target-triple>`. Tauri bundles it as a sidecar, so users
don't need Python. It's skipped when no core source changed.

To run the Python sources instead while working on the core, set up `.venv` with `make python`
(uv) and point `PORTMAN_PYTHON` at its Python: `PORTMAN_PYTHON=$PWD/../.venv/bin/python npm run tauri dev`.

> **macOS: build with no signing identity.** If `APPLE_SIGNING_IDENTITY` is set in your shell,
> Tauri signs with the hardened runtime, and the PyInstaller core can't load its own unpacked
> Python (library validation, "different Team IDs"): the app then shows **0 ports**. Build with
> `env -u APPLE_SIGNING_IDENTITY npm run tauri build -- --bundles app`. CI has no identity, so
> release builds are fine.

CI (`.github/workflows/build.yml`) builds the app for macOS, Windows and Linux and the CLI for
five platforms on every push; tagging `v*` publishes a release.

## Code layout

| Path | What it is |
|---|---|
| `core/port_manager.py` | Lists sockets with psutil, resolves processes, kills (graceful, then forced), finds and stops the LaunchAgent / systemd unit that would respawn a process |
| `core/known_ports.py` | Port → service names (PostgreSQL, Redis, Vite…) |
| `core/ipc.py`, `core_entry.py` | The JSON-RPC loop the app talks to |
| `gui/src-tauri/src/main.rs` | Starts the core sidecar and relays calls; open at login (`auto-launch`) |
| `gui/src/api/portman.ts` | Calls into the core |
| `gui/src/pages/Ports.tsx` | The page: search, filters, summary, bulk kill, info |
| `gui/src/components/PortTable.tsx` | The virtualised table (`@tanstack/react-virtual`) and row actions |
| `gui/src/portKinds.ts` | Which ports are the system's, and which are local web servers to open in a browser |
| `gui/src/components/SettingsDialog.tsx`, `gui/src/settings/` | Settings, kept in `localStorage` (open at login is read from the OS) |
| `cli/cmd_*.go` | `list`, `kill`, `info`, `watch` |

The app is styled after Claude, the same as Murmur, Relay and Capturita (warm paper tones, a
clay accent, Inter, Source Serif and JetBrains Mono).
