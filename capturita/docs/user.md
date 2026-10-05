# Capturita: user guide

[← Back to README](../README.md) · [Developer guide](dev.md)

- [Install](#install) · [Home](#home) · [Record](#record) · [Edit](#edit) · [Text](#text) · [Captions](#captions)
- [Hide private info](#hide-private-info) · [Audio](#audio) · [AI editing](#ai-editing)
- [Export and upload](#export-and-upload) · [Settings](#settings) · [Shortcuts](#shortcuts) · [Your files](#your-files) · [Troubleshooting](#troubleshooting)

## Install

1. Download [`Capturita_0.1.0_aarch64.dmg`](https://github.com/aryan2621/desktop-apps/releases/latest/download/Capturita_0.1.0_aarch64.dmg)
   (macOS 15 or later, Apple silicon).
2. Open it, drag **Capturita** into **Applications**, and open Capturita.

**"Apple could not verify Capturita is free of malware":** Capturita isn't signed with a paid
Apple Developer certificate, so macOS warns you the first time. Click **Done**, open **System
Settings → Privacy & Security**, scroll down, click **Open Anyway** next to Capturita and confirm.
If macOS says Capturita **"is damaged and can't be opened"**, run this once in Terminal and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Capturita.app
```

**First run:** a one-minute setup asks for **Screen Recording** (needed to record), **Microphone**
and **Camera** (only if you use them), and offers to download the captions model now (547 MB,
once) so captions are instant later. macOS may ask you to quit and reopen Capturita after
allowing Screen Recording.

## Home

Your recordings, newest first, as **cards** or a **table** (switch at the top right of the list;
Capturita remembers your choice). Click one to see it on the right: a silent preview, when it
was recorded, its length and size, and which tracks it has, with **Open in editor**, **Show in
Finder** and **Delete**. Double-click a recording to open it straight away.

## Record

- Click **New recording** (top right) and choose what to record: a **screen**, a **window** or an **area** you drag out.
- **Microphone** with optional **echo cancellation** (keeps speaker sound out of your mic; turn it
  off with headphones for the most natural voice), **system audio**, and a **camera** bubble.
- The camera bubble can be dragged anywhere. It's recorded separately, so you can move or hide it
  later in the editor.
- Start and stop with **Record** or **⌘⇧R** from any app. Capturita's window hides while you record.

## Edit

The editor opens when you stop. Nothing you do changes the original recording.

- **Trim and cut:** press **S** to mark a part, **S** again to cut it. Drag clip edges on the timeline.
- **Speed:** speed up any clip.
- **Auto-zoom:** zooms follow your cursor and clicks automatically; add, move or remove them on the timeline.
- **Cursor:** cursor styles and click effects.
- **Look:** backgrounds, padding, rounded corners and shadow; crop the recording.

## Text

Titles and labels with fonts, colours and animations: fade, rise, pop, slide, blur, typewriter,
word by word. Press **T** to add text at the playhead.

## Captions

Made from what's said in the recording, on this Mac (Whisper; the model downloads once, 547 MB).
Fix any word, style them (font, size, box or shadow, highlight the word being spoken), burn them
into the video and/or save an `.srt` file.

## Hide private info

Pixelate, blur or cover parts of the screen (emails, passwords, API keys, chats) for as long as
you choose. Press **H** to add one at the playhead. Boxes stay on the content while zooming and
are baked into every export.

## Audio

Volume per track (mic, system, music), fade in and out, and background music.

## AI editing

Describe an edit and an AI model on this Mac proposes cuts, speed-ups, zooms and titles. It
downloads once; pick which model in **Settings → AI editing**:

| Model | Download | Memory | |
|---|---|---|---|
| Qwen3 4B (default) | 2.4 GB | 8 GB | Quick, and good at most edits |
| Gemma 4 12B | 6.4 GB | 16 GB | Follows longer, more detailed requests more closely; slower |
 Review each one (include or leave it out, or jump to where it happens),
then apply.

Try: *"Cut the part about pricing"*, *"Speed up the parts where nothing happens"*, *"Add a title
at the start"*. It reads what you said (from captions), so it works best on recordings with speech.

One-click clean-ups remove **filler words** ("um", "uh") and **long pauses**.

## Export and upload

**⌘E** opens export. Choose:

- **Where:** **File** (an MP4 on this Mac), **YouTube** or **Drive** (exported, then uploaded).
- **File name:** type any name. If a file with that name exists, a number is added; nothing is overwritten.
- **Resolution:** 720p, 1080p or 4K. **Frame rate:** 30 (smaller) or 60 (smoother).

**Connecting Google (for YouTube and Drive):** uploads use your own free Google Cloud project,
so no shared key ships with the app and your keys stay in your Mac's Keychain. It's a one-time,
5-minute setup; then paste the Client ID and Client Secret in **Settings (⚙) → Google**.
Step by step, with privacy notes and fixes for every error: **[Google setup guide](google-setup.md)**.

YouTube keeps uploads **private** until your API project is audited by Google. To make one
public, upload the MP4 in YouTube Studio instead.

## Settings

Open with ⚙ in the header.

- **General:** light, dark or follow macOS; open the recordings folder; run setup again.
- **AI editing:** download, choose or delete AI models (see [AI editing](#ai-editing)).
- **Captions:** download or delete the speech model (547 MB).
- **Google:** your Client ID and Client Secret for uploads, who you're signed in as, sign out.

## Shortcuts

Press **?** in the editor to see these.

| Key | Action |
|---|---|
| **Space** | Play / pause |
| **← / →** | Back / forward 5 seconds |
| **S** | Mark a part to cut, then cut it (**Esc** cancels) |
| **T** | Add text at the playhead |
| **H** | Hide part of the screen at the playhead |
| **⌫** | Delete the selected clip, zoom, text, hidden area or caption |
| **⌘Z / ⌘⇧Z** | Undo / redo |
| **⌘+ / ⌘− / ⌘0** | Zoom the timeline in / out / fit |
| **⌥** while dragging | Skip snapping |
| **⌘E** | Export or upload |
| **⌘⇧R** | Start / stop recording (from anywhere) |

## Your files

- Recordings: `~/Movies/Capturita`
- Exports (MP4 and `.srt`): `~/Movies/Capturita/Exports`
- Google Client ID, Client Secret and sign-in: the macOS Keychain
- AI and speech models: `~/Library/Application Support/com.capturita.app/models`

## Troubleshooting

- **No screens or windows listed:** allow Capturita under **System Settings → Privacy & Security →
  Screen Recording**, then quit and reopen it.
- **Stopped recording after an update:** macOS can forget permissions for unsigned apps. Remove
  Capturita from Screen Recording, add it back, and reopen.
- **Your voice echoes or sounds thin:** with headphones, turn **Echo cancellation** off.
- **Upload says "Connect Google first", or another Google error:** see the
  [Google setup guide](google-setup.md#troubleshooting).
- **macOS asks to allow Keychain access after an update:** click **Always Allow**.
