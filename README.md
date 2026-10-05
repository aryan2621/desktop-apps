# Desktop apps

**Four small, private desktop apps. Everything that can run on your computer, does.**

| | | |
|---|---|---|
| **[Murmur](murmur/)** | Hold Fn and talk: your words are typed where your cursor is. Hold Right Option to ask Jarvis, a voice assistant that searches the web, reads your screen and acts on your Mac. | [⬇ macOS](https://github.com/aryan2621/desktop-apps/releases/latest/download/Murmur_0.1.0_aarch64.dmg) |
| **[Capturita](capturita/)** | Record your screen, then polish it: auto-zoom, captions, titles, hidden private info and AI editing by prompt. Export an MP4 or upload to YouTube or Drive. | [⬇ macOS](https://github.com/aryan2621/desktop-apps/releases/latest/download/Capturita_0.1.0_aarch64.dmg) |
| **[Relay](relay/)** | A workbench for MCP developers: connect a server, call its tools, save tests, and watch an AI use them, with your approval for every call. | [⬇ macOS](https://github.com/aryan2621/desktop-apps/releases/latest/download/Relay_0.1.0_aarch64.dmg) |
| **[PortMan](portman/)** | See every open port and the process behind it, and stop it in one click. Desktop app and command line tool. | [⬇ macOS](https://github.com/aryan2621/desktop-apps/releases/latest/download/PortMan_1.0.0_aarch64.dmg) · [Windows](https://github.com/aryan2621/desktop-apps/releases/latest/download/PortMan_1.0.0_x64-setup.exe) · [Linux](https://github.com/aryan2621/desktop-apps/releases/latest/download/port-man_1.0.0_amd64.AppImage) |

[All downloads](https://github.com/aryan2621/desktop-apps/releases/latest) · each app's page has a
demo, a user guide and a developer guide.

## Requirements

| | macOS | Notes |
|---|---|---|
| Murmur | 11+ | Apple silicon recommended. Speech model 550 MB; the assistant's AI 2.4–4.8 GB, optional. A Windows beta (dictation only) is on the releases page. |
| Capturita | 15+ | Apple silicon. Captions model 547 MB and AI model 2.4–6.4 GB, both optional. |
| Relay | 12+ | Apple silicon. On-device models 2.7–16.5 GB, optional (or use your Claude, OpenAI or Gemini key). |
| PortMan | 10.13+ | Apple silicon build. Also Windows and Linux. |

## Privacy

- Speech, AI and captions run on your Mac. Nothing is uploaded unless you ask (a YouTube upload, a
  web search, a cloud AI key you add).
- No analytics or tracking. No shared keys ship in the apps: anything that signs in (Google uploads
  in Capturita) uses your own account and keys, kept in your Keychain.

## Build from source

Each app's developer guide has the details. In short:

```bash
cd murmur    && pnpm install && pnpm tauri dev        # needs cmake
cd capturita && npm install  && npm run tauri dev     # needs Xcode's Swift tools and cmake
cd relay     && pnpm install && pnpm tauri dev        # needs cmake
cd portman/gui && npm install && npm run tauri dev    # needs uv
cd portman/cli && go build -o portman .
```

GitHub Actions builds every app on every push (download them from the run's **Artifacts**);
tagging `v*` publishes a release.
