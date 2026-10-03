# Jarvis

Private, on-device voice assistant for macOS, the companion to Murmur.
Hold **Right Option**, ask something, release: the answer is spoken back and shown on screen.
Speech → Whisper → a built-in AI (Qwen3 4B on llama.cpp, Metal) → macOS voice, all on this Mac.
Nothing has to be installed separately and nothing leaves your machine.

## Setup

```sh
pnpm install
pnpm tauri build --bundles app      # also builds the bundled llama.cpp server (needs cmake)
cp -R src-tauri/target/release/bundle/macos/Jarvis.app /Applications/
open /Applications/Jarvis.app
```

The first launch opens a setup flow: Accessibility and Microphone permissions, the two model
downloads (speech 547 MB, AI 2.4 GB, with progress), a voice, and a first question. It can be run
again from Settings → About.

## Use
**Quick question:** hold **Right Option**, ask, release. You get one answer and it's done.

**Conversation:** tap **Right Option** once. Talk; when you pause (~1.2 s) Jarvis answers, then
listens again by itself for your follow-up.
- **Tap** while it's talking → it stops and listens to you.
- **Tap** while it's listening → the conversation ends. So does **Esc**, or ~20 s of silence.
- The mic is off while Jarvis speaks, so it never hears (and answers) its own voice.

Anywhere: **Esc** stops an answer. The last few exchanges are remembered for 5 minutes, so
follow-ups work in either mode; **New Conversation** in the menu bar starts over.

## The app window
Open it from the menu bar icon (**Open Jarvis…**), or launch Jarvis again from Spotlight/Finder.
- **Home** — status and fixes (permissions, models), today's questions, response time, a box to
  **type a question**, and recent answers. Live answers stream in here too.
- **Insights** — questions per day, where response time goes, busiest hours
- **History** — every question and answer, searchable
- **Settings** — everything below, saved automatically (voice picker has a ▶ preview)

## Settings
Stored in `~/Library/Application Support/Jarvis/config.json`.

| Setting | Default | Notes |
|---|---|---|
| `hotkey` | `right_option` | `right_command`, `right_control`, `right_shift`, `fn`. Don't use the same key as Murmur |
| `brain` | `builtin` | `builtin` (bundled AI) or `ollama` to use your own Ollama instead |
| `llm_model` | `qwen3:8b` | With `brain: ollama`: any model from `ollama list` |
| `keep_alive` | `30m` | How long the AI stays in memory after a question (`-1` = always) |
| `voice` | `Daniel` | Any name from `say -v '?'`. Premium voices sound much better: System Settings → Accessibility → Spoken Content → Manage Voices |
| `speech_rate` | `195` | Words per minute |
| `pause_seconds` | `1.2` | Conversation mode: silence that sends what you said. Raise it if it cuts you off mid-thought |
| `conversation_timeout_seconds` | `20` | Conversation ends after this long without hearing you |
| `speech_threshold` | `0.012` | Mic level that counts as speech. Raise in a noisy room, lower if it misses a quiet voice |
| `speak_replies` | on | Off = answers only appear on screen |
| `whisper_model` | `large-v3-turbo-q5_0` | `small.en` is faster for short questions |
| `system_prompt` | built-in | Your own personality / instructions |
| `forget_after_minutes` | `5` | Fresh conversation after this long without a question |

## Development
Same stack as Murmur: React + Vite + Tailwind v4 + shadcn/ui (`src/`), floating widget in
`public/widget.html`, Rust core in `src-tauri/`.
```sh
pnpm tauri dev                     # run the app with hot reload
pnpm ui:dev                        # preview the UI in a browser with mock data (no Tauri)
pnpm typecheck
pnpm tauri build --bundles app
./src-tauri/target/release/jarvis --ask "what's a good name for a cat?"   # test the AI + voice headlessly
```
Logs: `~/Library/Application Support/Jarvis/jarvis.log` (menu bar → **Open Log**). It records
how long each answer took to start and finish.

The mic, Whisper, hotkey and widget-panel code are copied from Murmur (`audio.rs`,
`transcribe.rs`, `hotkey/`, `gesture.rs`, `model.rs`, `cleanup.rs`). The new parts are
`brain.rs` (runs the bundled llama.cpp server, or Ollama), `llm.rs` (streaming + sentence
splitting) and `speech.rs` (interruptible `say` queue). `scripts/build-llama-server.sh` builds the
server as one static binary that Tauri bundles as a sidecar.
