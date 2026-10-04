# Desktop apps

Three Tauri desktop apps.

- **[Capturita](capturita/)** — macOS screen recorder and editor: auto-zoom, trim, text, captions, hiding private info, AI editing by prompt (all on-device), export to MP4, upload to YouTube/Drive.
- **[Murmur](murmur/)** — private, on-device voice dictation and voice assistant for macOS. Hold Fn, speak, and the text is typed where your cursor is. Hold Right Option to ask the assistant (Jarvis), or tap it for a hands-free conversation: it searches the web, reads pages and your screen, and acts on the Mac (apps, browser, timers, reminders, calendar, music, volume, finding and opening files). Whisper, a built-in AI model (llama.cpp) and the macOS voice run locally; only search words and page addresses go online.
- **[PortMan](portman/)** — see and kill processes on your ports, as a CLI or a desktop GUI (macOS, Linux, Windows).

## Run

```bash
# Capturita (macOS 15+)
cd capturita && npm install && npm run tauri dev

# Murmur (macOS 11+, Apple Silicon recommended; the assistant's AI is an optional ~5 GB download)
cd murmur && pnpm install && pnpm tauri dev

# PortMan CLI
cd portman/cli && go build -o portman . && ./portman list
```

## Builds

GitHub Actions builds every app on every push; download them from the run's **Artifacts**. Tag `v*` to publish a release.
