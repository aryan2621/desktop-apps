# Desktop apps

Four Tauri desktop apps.

- **[Capturita](capturita/)** — macOS screen recorder and editor: auto-zoom, trim, text, export to MP4, upload to YouTube/Drive.
- **[Murmur](murmur/)** — private, on-device voice dictation for macOS: hold Fn, speak, and the text is typed where your cursor is. Whisper runs locally; nothing leaves your Mac.
- **[Jarvis](jarvis/)** — private, on-device voice assistant for macOS: hold Right Option to ask, tap it for a hands-free conversation. Whisper, a local Ollama model and the macOS voice answer out loud; nothing leaves your Mac.
- **[PortMan](portman/)** — see and kill processes on your ports, as a CLI or a desktop GUI (macOS, Linux, Windows).

## Run

```bash
# Capturita (macOS 15+)
cd capturita && npm install && npm run tauri dev

# Murmur (macOS 11+, Apple Silicon recommended)
cd murmur && pnpm install && pnpm tauri dev

# Jarvis (macOS 11+, Apple Silicon recommended; needs Ollama: brew install ollama && ollama pull qwen3:8b)
cd jarvis && pnpm install && pnpm tauri dev

# PortMan CLI
cd portman/cli && go build -o portman . && ./portman list
```

## Builds

GitHub Actions builds every app on every push; download them from the run's **Artifacts**. Tag `v*` to publish a release.
