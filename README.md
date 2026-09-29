# Desktop apps

Two Tauri desktop apps.

- **[Capturita](capturita/)** — macOS screen recorder and editor: auto-zoom, trim, text, export to MP4, upload to YouTube/Drive.
- **[PortMan](portman/)** — see and kill processes on your ports, as a CLI or a desktop GUI (macOS, Linux, Windows).

## Run

```bash
# Capturita (macOS 15+)
cd capturita && npm install && npm run tauri dev

# PortMan CLI
cd portman/cli && go build -o portman . && ./portman list
```

## Builds

GitHub Actions builds both apps on every push; download them from the run's **Artifacts**. Tag `v*` to publish a release.
