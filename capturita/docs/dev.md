# Capturita: developer guide

[← Back to README](../README.md) · [User guide](user.md)

## Build and install

Needs macOS 15+, Node 22, Rust (stable), Xcode or its command line tools (Swift), and `cmake`
(for llama.cpp's server).

```bash
cd capturita
npm install
npx tauri build --bundles app
cp -R src-tauri/target/release/bundle/macos/Capturita.app /Applications/
```

```bash
npm run tauri dev          # run with hot reload
npm run build:recorder     # rebuild only the Swift recorder helper
```

Both `tauri dev` and `tauri build` first build two sidecars into `src-tauri/binaries/`:
- `scripts/build-recorder.sh` builds the Swift recorder helper (`recorder/`).
- `scripts/build-llama-server.sh` builds llama.cpp's server for AI editing (static, Metal).

Launch with `CAPTURITA_KEEP_WINDOW=1` to keep the window visible while recording (to film
Capturita itself). Rebuilding changes the app's ad-hoc signature, so macOS may ask for Screen
Recording again. When run from a terminal, macOS gives the permissions to the terminal app.

CI (`.github/workflows/build.yml`) builds the `.dmg` on every push; tagging `v*` publishes a release.

## Code layout

Three parts: a **Swift helper** that records, a **Rust core** (Tauri) for files, models and
Google, and a **React UI** that edits, renders and encodes the video.

| Path | What it is |
|---|---|
| `recorder/Sources/CapturitaRecorder/` | ScreenCaptureKit recorder: sources, area picker, camera bubble, control bar, cursor tracking, mic, track writer, the 1080p preview copy (`Preview.swift`), moving deleted recordings to the Trash; talks to Rust over stdin/stdout (`IPC.swift`) |
| `src-tauri/src/helper.rs` | Starts and talks to the recorder helper |
| `src-tauri/src/recording.rs` | Recordings in `~/Movies/Capturita`, projects, permissions |
| `src-tauri/src/captions.rs` | Whisper (whisper.cpp + Metal): the speech models (the same list as Murmur's), the chosen one, and audio → timed words |
| `src-tauri/src/ai.rs` | AI editing: the model list (Qwen3 4B, Gemma 4 12B), downloads, the chosen model, the bundled llama-server, JSON-schema forced answers |
| `src-tauri/src/export.rs` | Streams the encoded MP4 to disk in chunks |
| `src-tauri/src/google.rs` | Google sign-in (PKCE, loopback), YouTube and Drive resumable uploads |
| `src/windows/` | Main window (recorder + recordings) and the editor |
| `src/editor/` | The editor: `model.ts` (the edit, auto-zoom), `motion.ts` (spring cursor and zoom camera), `render.ts` (draws a frame), `export.ts` (encodes the MP4 or GIF), `gif.ts` (GIF encoder), `aiEdit.ts`, timeline, panels |
| `src/components/` | Recorder panel, recordings list, setup flow, Settings dialog, shared UI |
| `src/lib/` | Tauri API wrapper, setup state, theme |

The UI is React 19 + Vite + Tailwind, styled after Claude (warm paper tones, a clay accent,
Inter, Source Serif and JetBrains Mono). Video is decoded and encoded in the webview with
[mediabunny](https://mediabunny.dev) (WebCodecs).

## How it works

- **Recording:** the Swift helper records the screen, system audio, mic and camera as separate
  tracks, plus cursor positions and clicks. Keeping them separate is what lets the editor move
  the camera bubble, restyle the cursor and add zooms afterwards.
- **Editing is non-destructive:** an edit is a description (cuts, speeds, zooms, text, hidden
  areas, captions, audio) applied on top of the original tracks at render time.
- **Motion:** the cursor and the zoom camera are springs (an exact damped-spring solution per
  step). A spring has state, but a frame must look the same in the preview and the export, so
  each path is simulated once over the whole recording at 120 steps a second, cached, and looked
  up by time (`motion.ts`). Before smoothing, pauses are held (no creeping across them) and hand
  shake is removed; the cursor is pinned to each click point. The camera zooms in log space,
  aims before zooming in, re-aims only when the cursor leaves the middle of the view, and keeps
  its velocity from one zoom to the next.
- **Preview:** the editor plays `screen-preview.mp4`, a 1080p copy made by the helper with
  AVFoundation the first time a recording is opened (kept only if its length matches; never made
  during a recording). Full-size Retina H.264 of busy content can peak far above what the webview
  decodes in real time. Screen motion blur is left out of the preview for the same reason.
- **Export:** the webview renders each frame, encodes with WebCodecs, and streams the MP4 to Rust
  in binary chunks with their byte position, so long exports never have to fit in memory. A
  cancelled or failed export's partial file is deleted.
- **Captions:** the editor sends each chosen track (mic, system audio) to Rust separately as
  16 kHz mono. The audio is cut into ~15 s windows at quiet moments and trimmed to where there's
  sound (relative to the track's own noise and loudness), since Whisper invents words like
  "Thank you." for silence. The language is detected from the window with the most speech; a
  short window that seems to switch is redone in that language. Words are assembled from the
  tokens' raw bytes, so non-Latin letters split across tokens stay whole. Large models decode
  with beam search, the small ones greedily. Words stretched back over a pause are moved to where
  the voice actually is.
- **AI editing:** the request, the transcript and the recording's details go to the local model;
  llama.cpp turns the answer's JSON schema into a grammar, so the reply is always valid edits.
  The server starts only when needed (with thinking off) and stops after 10 minutes idle. The
  chosen model is saved in `ai-settings.json` in the app config folder; choosing another stops
  the running one so the next request starts the new one. A model added to `MODELS` should be
  checked against a real request (`src/editor/aiEdit.ts` builds it) before shipping.
- **Google:** the user's own "Desktop app" OAuth client, entered in Settings and kept in the
  Keychain (service `com.capturita.app.google`), so no secret ships in the app. An old
  `google-client.json` is imported into the Keychain once and deleted. The browser signs in and
  redirects to a one-off server on 127.0.0.1; the refresh token is kept in the Keychain, access
  tokens only in memory. Saving a different Client ID signs out.
