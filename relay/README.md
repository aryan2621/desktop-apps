# Relay

**A workbench for MCP developers. Connect your server, poke every tool, and watch an AI use it.**

<!-- DEMO VIDEO: paste the https://github.com/user-attachments/assets/... link on the next line -->

- **Connect** any MCP server: a local command (stdio) or a remote URL (Streamable HTTP), with
  headers, environment variables or a browser sign-in (OAuth).
- **Inspect** its tools, resources and prompts, call them with a form, and read the server's logs.
- **Test**: save a call with its expected answer and re-run them all after every change.
- **Playground**: give an AI a task and watch it pick your tools. You approve every call. Use a
  model that runs on your Mac (Qwen3.5, Gemma 4, Qwen3.8) or Claude, OpenAI and Gemini with your key.

**[⬇ Download for macOS](https://github.com/aryan2621/desktop-apps/releases/latest/download/Relay_0.1.0_aarch64.dmg)**
· macOS 12+, Apple silicon · [all downloads](https://github.com/aryan2621/desktop-apps/releases/latest)

📖 **[User guide](docs/user.md)** — every page, model and setting
🛠 **[Developer guide](docs/dev.md)** — build from source, code layout, how it works

## Install

1. Open the `.dmg` and drag **Relay** into **Applications**, then open it.
2. If macOS says **"Apple could not verify Relay is free of malware"**: click **Done**, go to
   **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. (Relay isn't
   signed with a paid Apple certificate; that's the only reason for the warning.)
3. If it says Relay **"is damaged"**, run this once in Terminal and open it again:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Relay.app
   ```

## Quick start

1. **Servers → Try the example server** (works right away), or **Add a connection** with your
   own, e.g. command `npx`, arguments `-y @modelcontextprotocol/server-everything`.
2. **Inspector:** pick a tool, fill in its arguments, **Run tool**. **Keep this as a test** to save it.
3. **Playground:** pick a model (download one from **Models**, or add an API key), ask something
   that needs your tools, and approve each call (**Approve & run**).
4. **Tests → Run all** after you change your server. **Activity** shows every call and its timing.

## Build from source

```bash
cd relay && pnpm install && pnpm tauri build --bundles app
```

Needs Node, pnpm, Rust and `cmake`. Details in the [developer guide](docs/dev.md).
