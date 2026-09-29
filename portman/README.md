# PortMan

**Own your ports.**

A premium, cross-platform port manager for developers. Features a gorgeous CLI with live TUI and a native desktop GUI built with Tauri.

![PortMan](assets/screenshot.png)

## Features

- **Cross-platform**: macOS, Linux, Windows
- **Dual interface**: Powerful CLI + Native GUI
- **Live monitoring**: Real-time port activity
- **Process management**: Kill by port, PID, or connection state
- **Service detection**: Auto-tag well-known ports (PostgreSQL, Redis, etc.)
- **Beautiful UI**: Custom color palette, animations, dark/light themes

## Installation

### CLI (Go)

```bash
# Clone the repository
git clone https://github.com/aryan2621/portman.git
cd portman/cli

# Build
go build -o portman .

# Install globally (optional)
sudo mv portman /usr/local/bin/
```

Or download pre-built binaries from releases.

### GUI (Tauri + Python Core)

The GUI ships the Python core as one executable (built with PyInstaller by `scripts/build-core.sh`), so installed apps don't need Python. Building it needs [uv](https://docs.astral.sh/uv/):

```bash
cd portman/gui
npm install
npm run tauri build   # builds the core, then the app
```

Set `PORTMAN_PYTHON=1` to run the Python sources instead of the bundled core while working on it.

## CLI Usage

```bash
# List all active ports
portman list

# Filter by state
portman list --state LISTEN

# Filter by process name
portman list --proc node

# JSON output for piping
portman list --json | jq

# Kill process by port
portman kill 8080

# Kill all in TIME_WAIT state
portman kill --state TIME_WAIT

# Live TUI with keyboard shortcuts
portman watch

# Detailed port info
portman info 8080
```

### CLI Keyboard Shortcuts (Watch Mode)

| Key | Action |
|-----|--------|
| `k` | Kill selected port |
| `f` / `/` | Filter by process |
| `r` | Refresh |
| `1` | Sort by port |
| `2` | Sort by state |
| `3` | Sort by process |
| `q` | Quit |

## GUI Features

- **Ports Table**: Filterable, sortable, multi-select with bulk kill
- **Settings**: Theme toggle, refresh interval, watched ports

### GUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘/Ctrl + R` | Refresh |
| `⌘/Ctrl + F` | Search |
| `⌘/Ctrl + K` | Kill selected |
| `Esc` | Close modal |

## Project Structure

```
portman/
├── core/              # Python core library (for GUI)
│   ├── port_manager.py
│   ├── known_ports.py
│   └── ipc.py
├── cli/               # Go CLI (standalone)
│   ├── main.go
│   ├── port.go
│   └── cmd_*.go
├── gui/               # Tauri React app
│   ├── src/
│   └── src-tauri/
├── Makefile           # make python → uv sync (Python env)
├── uv.lock
└── pyproject.toml
```

## Architecture

- **CLI (Go)**: Standalone binary using `gopsutil` for port detection. No Python required.
- **GUI (Tauri + React)**: Frontend with Python core backend via JSON-RPC IPC.

## Configuration

Settings stored in `~/.portman/settings.json`:

```json
{
    "theme": "dark",
    "refresh_interval": 3,
    "accent_color": "#6C63FF",
    "startup_on_login": false,
    "watched_ports": [8080, 3000]
}
```

## Color Palette

| Color | Hex | Usage |
|-------|-----|-------|
| Primary | `#6C63FF` | Accent, logo, buttons |
| Secondary | `#00D9B5` | Success, mint highlights |
| Danger | `#FF4C6A` | Kill actions, errors |
| Warning | `#FFB347` | Amber for waiting states |
| Success | `#00E5A0` | Neon green for listening |

## License

MIT License - see LICENSE file for details.
