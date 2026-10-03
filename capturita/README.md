# Capturita

macOS screen recorder and editor (macOS 15+). Record the screen, a window or an area with your
microphone, system audio and camera, then polish it in the built-in editor and export an MP4 or
upload it straight to YouTube or Google Drive.

- **Record**: screen / window / area, mic, system audio, camera bubble, ⌘⇧R from anywhere.
- **Edit**: trim and cut, speed up clips, auto-zoom that follows your cursor, cursor styles and
  click effects, backgrounds, padding, rounded corners and shadow.
- **Text**: titles with fonts, colours and animations (fade, rise, pop, slide, blur,
  typewriter, word by word).
- **Captions**: made from what's said in the recording, on this Mac (Whisper; the speech model
  downloads once, 547 MB). Fix any word, style them (font, size, box or shadow, highlight the
  word being spoken), burn them into the video and/or save an `.srt` file.
- **Hide private info**: pixelate, blur or cover parts of the screen (emails, passwords, API
  keys, chats) for as long as you choose. Boxes stay on the content while zooming and are baked
  into every export; the original recording is never changed.
- **Audio**: volume per track, fade in/out, background music.
- **AI editing**: describe an edit — "cut the part about pricing", "speed up where nothing
  happens", "add a title" — and a small AI model on this Mac (Qwen3 4B on a bundled llama.cpp
  server; downloads once, 2.4 GB) proposes cuts, speed-ups, zooms and titles to review and apply.
  One-click clean-ups remove filler words and long pauses.
- **Share**: export to MP4, upload to YouTube or Google Drive.

## Run

```bash
npm install
npm run tauri dev          # builds the Swift recorder helper, then starts the app
npx tauri build --bundles app
```

Recordings and exports are saved in `~/Movies/Capturita`. Launching with
`CAPTURITA_KEEP_WINDOW=1` keeps the window visible while recording (to film Capturita itself).
