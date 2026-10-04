# Jarvis

Private, on-device voice assistant for macOS, the companion to Murmur.
Hold **Right Option**, ask something, release: Jarvis answers out loud, or does it.
Speech → Whisper → a built-in AI (Qwen3 8B on llama.cpp, Metal) → macOS voice, all on this Mac.
Nothing has to be installed separately. Your voice and conversation never leave the Mac; with
web access on, only search words and page addresses do.

## Setup

```sh
pnpm install
pnpm tauri build --bundles app      # also builds the bundled llama.cpp server (needs cmake)
cp -R src-tauri/target/release/bundle/macos/Jarvis.app /Applications/
open /Applications/Jarvis.app
```

The first launch opens a setup flow: Accessibility and Microphone permissions, the two model
downloads (speech 547 MB, AI 4.8 GB, with progress), a voice, and a first question. It can be run
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

## What it can do
Ask in your own words; the AI picks the action (tool calling) and confirms in a few words.

| | Examples |
|---|---|
| **Web** | "Who won the last F1 race?", "What's Bitcoin at?", "Read this article and summarise it" |
| **Weather** | "Will it rain tomorrow?", "Weather in London" (set **Your city** in Settings) |
| **Sums** | "10 tomatoes at 40 rupees each, plus 100 for detergent and 100 for milk: what's the total?", "What's 18% of 2340?" |
| **Browser** | "Play the Kesariya song" (top YouTube result, starts by itself), "Open github.com", "Open Amazon and search for umbrella", "New tab", "Which tabs are open?", "Switch to the LinkedIn tab", "Close this tab", "Go back" |
| **Apps** | "Open Slack", "Quit Spotify", "What apps are open?" |
| **Screen** | "What's on my screen?", "Read this to me", "What does this error say?" (reads the text in the window in front, in any app, on the Mac; needs Screen Recording permission once) |
| **Files** | "Find files named invoice", "Open my resume", "Open the latest download", "What's on my Desktop?" |
| **Mac** | "Volume to 30", "Turn it down", "Dark mode", "Lock the screen", "Take a screenshot", "How much battery?" |
| **Music** | "Pause", "Next song" (Spotify or Music) |
| **Timers** | "10 minute pasta timer", "How long is left?", "Cancel the timer" |
| **Reminders** | "Remind me to call Mum tomorrow at 6" |
| **Calendar** | "What's on today?", "Anything on Friday?" (includes repeating events) |

Jarvis deliberately doesn't click or type inside apps or web pages, and doesn't move, rename or
delete files: a small local model gets those multi-step tasks wrong too often. It says so when asked.

How it works (`src-tauri/src/actions/`): every question takes three steps.
1. **Decide** (`mod.rs`): the AI picks one action from a fixed list (`chat`, `calculate`,
   `web_search`, `play_youtube`, `open_website`, `open_app`, `list_folder`, `timer`…). Its answer is
   JSON that llama.cpp forces, token by token, to match that list's schema, so it can't skip a
   field, garble the format, or talk instead of choosing.
2. **Do**: plain code runs that one action.
3. **Say**: actions that just do something get a fixed confirmation ("Opening Slack.",
   "Volume is now 30%."). Actions that find something out (web search, a folder's contents, the
   calendar, a sum) and plain conversation get a short reply written by the AI from the result,
   streamed so speech starts at once. Closing offers ("Let me know if…") are dropped.

The decision and a short form of its result stay in the conversation, so "open that in Brave"
knows what "that" is. Sums are never worked out by the AI: it writes the expression
(`10*40 + 100`, `18% * 2340`) and `calculate.rs` evaluates it.
- **Web search** (`web.rs`) reads Brave's results (DuckDuckGo if Brave refuses) and the top two
  pages at once, so most answers take one round. Results are kept for 10 minutes. Pages that need
  JavaScript open in a hidden WebKit window. Weather comes from wttr.in. No account or key.
- **Browser** (`browser.rs`) drives the browser you use, so you stay signed in, with AppleScript
  for tabs. "Play …" finds the top video on YouTube's results page and opens it, where it plays
  by itself. Common sites can be named without their address ("youtube", "gmail"), and a site can
  be searched directly (YouTube, Amazon, GitHub, Wikipedia…). Firefox gets keyboard shortcuts.

**Asking first:** opening an archive, installer or script (`.zip`, `.dmg`, `.pkg`, `.sh`…) is
asked about out loud. Say yes or no (or use the widget's buttons); silence or a stop counts as no.

The first time an action needs another app, macOS asks once (Automation, Calendars).
**Act on this Mac** and **Look things up online** can each be turned off in Settings → Actions & web.

**Models:** the built-in AI is Qwen3 8B (4.8 GB download, run without its "thinking" so answers
start at once). Settings → Brain → Model can switch to the lighter Qwen3 4B (2.4 GB) on Macs with
less than 16 GB of memory.

## The app window
Open it from the menu bar icon (**Open Jarvis…**), or launch Jarvis again from Spotlight/Finder.
- **Home** — status and fixes (permissions, models), today's questions, response time, a box to
  **type a question**, and recent answers. Live answers stream in here too.
- **Insights** — questions per day, where response time goes, busiest hours
- **History** — every question and answer, searchable
- **Settings** — everything below, saved automatically (voice picker has a ▶ preview)

**Echo cancellation** (Settings → Microphone, on by default): with the System default microphone,
Jarvis records through Apple's voice processing (the echo cancellation FaceTime uses), so music or
a video playing from the Mac's speakers is removed from what it hears. It opens the mic about a
quarter of a second slower; turn it off if the start of your first word gets clipped.

## Settings
Stored in `~/Library/Application Support/Jarvis/config.json`.

| Setting | Default | Notes |
|---|---|---|
| `hotkey` | `right_option` | `right_command`, `right_control`, `right_shift`, `fn`. Don't use the same key as Murmur |
| `brain` | `builtin` | `builtin` (bundled AI) or `ollama` to use your own Ollama instead |
| `builtin_model` | `8b` | Built-in model: `8b`, or `4b` for a lighter one |
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
| `actions` | on | Act on the Mac (apps, browser, timers, reminders, calendar, volume, files…) |
| `web_access` | on | Web search, reading pages, weather. Off = nothing leaves the Mac |
| `location` | empty | City for the weather; empty = guessed from your connection |

## Development
Same stack as Murmur: React + Vite + Tailwind v4 + shadcn/ui (`src/`), floating widget in
`public/widget.html`, Rust core in `src-tauri/`.
```sh
pnpm tauri dev                     # run the app with hot reload
pnpm ui:dev                        # preview the UI in a browser with mock data (no Tauri)
pnpm typecheck
pnpm tauri build --bundles app
./src-tauri/target/release/jarvis --ask "what's the weather in Pune?"   # test the AI, actions + voice headlessly
JARVIS_QUIET=1 ./src-tauri/target/release/jarvis --ask "…"               # same, without speaking
JARVIS_DEBUG=1 JARVIS_QUIET=1 ./src-tauri/target/release/jarvis --ask "…" # also print each tool result
JARVIS_YES=1 …                                                           # answer yes to confirmations
open -n --env JARVIS_ASK="set a 1 minute timer" --env JARVIS_QUIET=1 /Applications/Jarvis.app   # ask inside the app
```
Logs: `~/Library/Application Support/Jarvis/jarvis.log` (menu bar → **Open Log**). It records
how long each answer took to start and finish.

The mic, Whisper, hotkey and widget-panel code are copied from Murmur (`audio.rs`,
`transcribe.rs`, `hotkey/`, `gesture.rs`, `model.rs`, `cleanup.rs`). The new parts are
`brain.rs` (runs the bundled llama.cpp server, or Ollama), `llm.rs` (streaming, tool calls,
sentence splitting), `actions/` (the tools) and `speech.rs` (interruptible `say` queue). `scripts/build-llama-server.sh` builds the
server as one static binary that Tauri bundles as a sidecar.
