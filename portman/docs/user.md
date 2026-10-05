# PortMan: user guide

[← Back to README](../README.md) · [Developer guide](dev.md)

- [Install](#install) · [The app](#the-app) · [Stopping a process](#stopping-a-process) · [Settings](#settings)
- [The command line tool](#the-command-line-tool) · [Troubleshooting](#troubleshooting)

## Install

| | Download | Then |
|---|---|---|
| **macOS** (Apple silicon) | [`PortMan_1.0.0_aarch64.dmg`](https://github.com/aryan2621/desktop-apps/releases/latest/download/PortMan_1.0.0_aarch64.dmg) | Drag PortMan into Applications and open it |
| **Windows** | [`PortMan_1.0.0_x64-setup.exe`](https://github.com/aryan2621/desktop-apps/releases/latest/download/PortMan_1.0.0_x64-setup.exe) or [`.msi`](https://github.com/aryan2621/desktop-apps/releases/latest/download/PortMan_1.0.0_x64_en-US.msi) | Run the installer |
| **Linux** | [`.AppImage`](https://github.com/aryan2621/desktop-apps/releases/latest/download/port-man_1.0.0_amd64.AppImage) or [`.deb`](https://github.com/aryan2621/desktop-apps/releases/latest/download/port-man_1.0.0_amd64.deb) | `chmod +x` the AppImage and run it, or `sudo apt install ./port-man_1.0.0_amd64.deb` |

**The first time you open it**, your system may warn you, because PortMan isn't signed with a
paid certificate:

- **macOS, "Apple could not verify PortMan is free of malware":** click **Done**, open **System
  Settings → Privacy & Security**, scroll down, click **Open Anyway** next to PortMan and confirm.
  If it says PortMan **"is damaged and can't be opened"**, run this once in Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/PortMan.app
  ```
- **Windows, "Windows protected your PC":** click **More info → Run anyway**.

Nothing else to install: the app brings everything it needs.

## The app

Every open port on your computer, updating live (the **Live** switch at the top turns that off).

| Column | What it means |
|---|---|
| **Port** | The port number |
| **Process** | The program using it (hover for its full command line) |
| **Service** | What usually runs there: PostgreSQL, Redis, Vite, Next.js… |
| **Host** | Who can connect: `localhost` (this computer only), `all` (any network), or one address |
| **State** | Listening (waiting for connections), Established (connected), Time-wait / Close-wait (closing) |

- **Search** by port, process name, PID or command line.
- **Filters:** All, Listening, Established, Time-wait, Close-wait.
- **System ports** (held by the operating system itself: Control Center, AirPlay…) are hidden.
  The **N system hidden** pill shows them again.
- **Row actions:** copy the address, copy the PID, **Info** (command, working directory,
  environment, user, when it started), **open in the browser** (local web servers only), **Kill**.

Press **⌘,** (Ctrl+, on Windows and Linux) for Settings.

## Stopping a process

Click **Kill** on a row, or select several rows and click **Kill** at the top.

- PortMan asks first. With **Type to confirm kills** on, you type the port number (or `KILL`
  for several), so you can't stop the wrong thing by accident.
- It asks the process to quit, and forces it only if it doesn't.
- If a **LaunchAgent** (macOS) or **systemd service** (Linux) keeps the process alive, PortMan
  stops that too, so the process doesn't come straight back.
- Processes owned by another user (or the system) can't be stopped without admin rights;
  PortMan says so.

## Settings

| Setting | What it does |
|---|---|
| **Appearance** | Light, dark, or follow the system |
| **Refresh every** | How often the list updates while Live is on (1–10 seconds) |
| **Open at login** | Start PortMan when you log in (shows where your system manages login items) |
| **Show when opened** | Start with all ports, or only listening ones |
| **Hide system ports** | Hide ports the operating system itself holds |
| **Type to confirm kills** | Type the port number (or `KILL`) before stopping a process |

Settings are saved in the app on this computer.

## The command line tool

A separate, single-file program: no install, no Python.

**Install:** download `portman-<os>-<arch>` from the
[releases page](https://github.com/aryan2621/desktop-apps/releases/latest)
(`darwin-arm64`, `darwin-amd64`, `linux-amd64`, `linux-arm64`, `windows-amd64.exe`), then on
macOS or Linux:

```bash
chmod +x portman-darwin-arm64
xattr -d com.apple.quarantine portman-darwin-arm64   # macOS only: allow a downloaded program to run
sudo mv portman-darwin-arm64 /usr/local/bin/portman
```

**Use:**

```bash
portman list                        # all ports
portman list --state LISTEN         # only listening (also ESTABLISHED, TIME_WAIT, CLOSE_WAIT)
portman list --proc node            # by process name
portman list --json | jq            # JSON, for scripts

portman kill 8080                   # stop what's on port 8080 (asks first)
portman kill 8080 --force           # without asking
portman kill 8080 --dry-run         # show what would be stopped
portman kill --state TIME_WAIT      # everything in a state

portman info 8080                   # details about a port
portman watch                       # live view in the terminal
portman version
```

**Keys in `portman watch`:**

| Key | Action |
|---|---|
| `k` | Kill the selected port |
| `f` or `/` | Filter by process |
| `r` | Refresh |
| `1` / `2` / `3` | Sort by port / state / process |
| `q` | Quit |

## Troubleshooting

- **The app shows no ports:** quit and reopen it. If you built it yourself, see the
  [developer guide](dev.md#build-the-desktop-app).
- **"Access denied" when killing:** the process belongs to another user or the system. Use
  `sudo portman kill <port>` in Terminal.
- **A process comes back after killing it:** something else restarts it (a process manager like
  pm2, Docker, or an IDE). Stop it there.
- **macOS: "portman cannot be opened because the developer cannot be verified":** run the
  `xattr -d com.apple.quarantine` line above.
