# Jarvis

Private, on-device voice assistant for macOS, the companion to Murmur.
Hold **Right Option**, ask something, release: the answer is spoken back and shown on screen.
Speech → Whisper (local) → Ollama (local) → macOS voice. Nothing leaves your machine.

## Setup

```sh
brew install ollama && ollama serve     # or install the Ollama app
ollama pull qwen3:8b                    # skip if `ollama list` already shows it

pnpm install
pnpm tauri build --bundles app
cp -R src-tauri/target/release/bundle/macos/Jarvis.app /Applications/
open /Applications/Jarvis.app
```

Grant **Accessibility** and **Microphone** to Jarvis in System Settings → Privacy & Security.
If Murmur has already downloaded the Whisper model, Jarvis uses that copy instead of downloading it again.

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
- **Home** — status and fixes (permissions, Ollama), today's questions, response time, a box to
  **type a question**, and recent answers. Live answers stream in here too.
- **Insights** — questions per day, where response time goes, busiest hours
- **History** — every question and answer, searchable
- **Settings** — everything below, saved automatically (voice picker has a ▶ preview)

## Settings
Stored in `~/Library/Application Support/Jarvis/config.json`.

| Setting | Default | Notes |
|---|---|---|
| `hotkey` | `right_option` | `right_command`, `right_control`, `right_shift`, `fn`. Don't use the same key as Murmur |
| `llm_model` | `qwen3:8b` | Any model from `ollama list`, e.g. `qwen2.5:7b` |
| `keep_alive` | `30m` | How long Ollama keeps the model loaded between questions |
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
./src-tauri/target/release/jarvis --ask "what's a good name for a cat?"   # test Ollama + voice headlessly
```
Logs: `~/Library/Application Support/Jarvis/jarvis.log` (menu bar → **Open Log**). It records
how long each answer took to start and finish.

The mic, Whisper, hotkey and widget-panel code are copied from Murmur (`audio.rs`,
`transcribe.rs`, `hotkey/`, `gesture.rs`, `model.rs`, `cleanup.rs`). The new parts are
`llm.rs` (Ollama streaming + sentence splitting) and `speech.rs` (interruptible `say` queue).
