# Desktop apps

Two native desktop apps built with [Tauri](https://tauri.app), in one repository.

| App | What it is | Stack | Platforms |
|---|---|---|---|
| [**Capturita**](capturita/) | Screen recorder and editor: record your screen, a window or an area with camera and audio, then trim, zoom, style and export or upload to YouTube and Google Drive. | Tauri 2 · React · Rust · Swift (ScreenCaptureKit) | macOS 15+ |
| [**PortMan**](portman/) | Port manager for developers: see what's listening, which process owns a port, and kill it — as a CLI with a live TUI or a desktop GUI. | Go CLI · Tauri 1 · React · Python core | macOS, Linux, Windows |

## Capturita

- **Record** a display, a window (on any Space) or an area, with system audio, an echo-cancelled microphone and a camera bubble. A floating control bar stays above full-screen apps; `⌘⇧R` starts and stops from anywhere.
- **Edit** on a timeline with thumbnails and a waveform: trim, cut with markers, change speed without changing pitch, backgrounds, padding and corners, crop and aspect ratios (including 9:16), auto-zoom on clicks, smooth cursor and click effects, camera layout, text overlays, per-track volume and fades, undo/redo.
- **Export** H.264/AAC MP4 up to 4K with the same renderer as the preview, or upload straight to YouTube or Google Drive.

Everything is recorded as separate tracks (screen without cursor, system audio, microphone, camera, cursor data) and edits are saved next to them in `edit.json`, so the original recording is never changed.

```bash
cd capturita
npm install
npm run tauri dev          # builds the Swift helper, then runs the app
```

Uploads need your own Google Cloud OAuth client ("Desktop app"), saved as
`~/Library/Application Support/com.capturita.app/google-client.json`.

## PortMan

```bash
# CLI
cd portman/cli && go build -o portman . && ./portman list

# GUI (needs the Python core: https://docs.astral.sh/uv/)
cd portman && make python
cd gui && npm install && npm run tauri build
```

See [portman/README.md](portman/README.md) for CLI usage.

## Builds

[GitHub Actions](.github/workflows/build.yml) builds every push and pull request:

- **Capturita** — macOS `.dmg` (ad-hoc signed)
- **PortMan GUI** — macOS `.dmg`, Linux `.deb`/`.AppImage`, Windows installer
- **PortMan CLI** — macOS, Linux and Windows binaries

Download them from the run's **Artifacts**. Pushing a tag like `v1.0.0` also attaches them to a GitHub Release.

> CI builds of Capturita are ad-hoc signed, not notarized. macOS asks you to confirm the first launch (right-click → Open), and screen-recording permission has to be granted again for each new build.
