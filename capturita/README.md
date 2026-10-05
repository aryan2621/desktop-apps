# Capturita

**Record your screen, make it look great, share it. Screen recorder and editor for macOS.**

<!-- DEMO VIDEO: paste the https://github.com/user-attachments/assets/... link on the next line -->

- **Record** a screen, a window or an area, with your mic, system audio and a camera bubble. **⌘⇧R** from anywhere.
- **Edit:** trim, split and cut, speed up, smooth spring auto-zoom on your clicks that follows your cursor, a smoothed cursor with click effects, backgrounds (gradients, colours or your own image), rounded corners and shadow.
- **Captions** from your voice, the Mac's audio or both (any of 7 speech models), **titles** with animations, and **hide private info** (blur emails, passwords, keys).
- **AI editing:** type *"cut the part about pricing"* or *"speed up where nothing happens"* and review the edits it suggests.
- **Share:** export an MP4 (up to 4K, 60 fps) or a GIF with one-click presets, copy it to paste anywhere, or upload straight to YouTube or Google Drive.

Captions and AI editing run on your Mac. Your recordings are never uploaded unless you choose to.

**[⬇ Download for macOS](https://github.com/aryan2621/desktop-apps/releases/latest/download/Capturita_0.1.0_aarch64.dmg)**
· macOS 15+, Apple silicon · [all downloads](https://github.com/aryan2621/desktop-apps/releases/latest)

📖 **[User guide](docs/user.md)** — recording, every editing tool, shortcuts, export and upload
☁️ **[Google setup](docs/google-setup.md)** — upload to YouTube and Drive with your own Google account
🛠 **[Developer guide](docs/dev.md)** — build from source, code layout, how it works

## Install

1. Open the `.dmg` and drag **Capturita** into **Applications**, then open it.
2. If macOS says **"Apple could not verify Capturita is free of malware"**: click **Done**, go to
   **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. (Capturita
   isn't signed with a paid Apple certificate; that's the only reason for the warning.)
3. If it says Capturita **"is damaged"**, run this once in Terminal and open it again:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Capturita.app
   ```
4. The setup asks for **Screen Recording** (needed), **Microphone** and **Camera**, and offers the
   captions model (547 MB, optional, once). Other speech models, AI models, theme and Google uploads are in **Settings** (⚙).

## Quick start

1. Click **New recording**, pick a screen, window or area, turn on mic / camera if you like, and press **Record**.
2. Press **⌘⇧R** (or the stop button) to finish. The editor opens.
3. Zooms are added on your clicks. Press **S** to split, **C** to cut a part, **Z** to add a zoom, **T** to add text, **H** to hide something. **?** shows every shortcut.
4. **⌘E** to export an MP4 or upload. Files are saved in `~/Movies/Capturita`.

## Build from source

```bash
cd capturita && npm install && npx tauri build --bundles app
```

Needs Node, Rust, Xcode's Swift tools and `cmake`. Details in the [developer guide](docs/dev.md).
