# Capturita

macOS screen recorder and editor (macOS 15+). Record the screen, a window or an area with your
microphone, system audio and camera, then polish it in the built-in editor and export an MP4 or
upload it straight to YouTube or Google Drive.

- **Record**: screen / window / area, mic, system audio, camera bubble, ⌘⇧R from anywhere.
- **Edit**: trim and cut, speed up clips, auto-zoom that follows your cursor, cursor styles and
  click effects, backgrounds, padding, rounded corners and shadow.
- **Text**: titles and captions with fonts, colours and animations (fade, rise, pop, slide,
  blur, typewriter, word by word).
- **Audio**: volume per track, fade in/out, background music.
- **Share**: export to MP4, upload to YouTube or Google Drive.

## Run

```bash
npm install
npm run tauri dev          # builds the Swift recorder helper, then starts the app
npx tauri build --bundles app
```

Recordings and exports are saved in `~/Movies/Capturita`. Launching with
`CAPTURITA_KEEP_WINDOW=1` keeps the window visible while recording (to film Capturita itself).
