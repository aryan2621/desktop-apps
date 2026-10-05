# Relay: developer guide

[← Back to README](../README.md) · [User guide](user.md)

## Build and install

Needs Node 22, pnpm, Rust (stable) and `cmake` (for llama.cpp's server). macOS on Apple silicon.

```bash
cd relay
pnpm install
pnpm tauri build --bundles app
cp -R src-tauri/target/release/bundle/macos/Relay.app /Applications/
```

```bash
pnpm tauri dev      # run with hot reload
pnpm ui:dev         # the UI alone in a browser (port 1428), no Tauri
pnpm typecheck      # TypeScript check
```

Both `tauri dev` and `tauri build` first run `scripts/build-llama-server.sh`, which downloads
llama.cpp (pinned version), builds `llama-server` as one static binary with the Metal shaders
embedded, and puts it in `src-tauri/binaries/` for Tauri to bundle as a sidecar. It's skipped
when that version is already built.

CI (`.github/workflows/build.yml`) builds the `.dmg` on every push; tagging `v*` publishes a release.

## Code layout

The UI is React 19 + Vite (`src/`), styled after Claude (warm paper tones, a clay accent, Inter,
Source Serif and JetBrains Mono). It talks to Rust through Tauri commands, wrapped in `src/api.ts`.

| File | What it is |
|---|---|
| `src/App.tsx` | Shell, navigation, Servers, Tests and Activity pages |
| `src/ServerEditor.tsx` | Add / edit a connection (stdio or HTTP, headers, env) |
| `src/Inspector.tsx` | Tools, resources, prompts and the stdio log; run a request, save a test |
| `src/Playground.tsx` | Chat with a model that can call the selected tools, with approval |
| `src/Models.tsx`, `src/Providers.tsx` | On-device model downloads; API-key providers |
| `src/types.ts` | Shared types and the provider list |

| File | What it is |
|---|---|
| `src-tauri/src/lib.rs` | Tauri commands: workspace, connect/disconnect, call tool, AI step, tests, logs |
| `src-tauri/src/mcp.rs` | MCP clients (via `rmcp`): stdio with a login-shell `PATH`, Streamable HTTP, stderr tail |
| `src-tauri/src/oauth.rs` | MCP OAuth sign-in: browser, one-time local callback, tokens in the Keychain, renewal |
| `src-tauri/src/ai.rs` | One request format per provider: Claude, OpenAI (Responses API), and OpenAI-compatible (Gemini, llama.cpp) |
| `src-tauri/src/models.rs` | Model catalog, recommendation by RAM, downloads, starting/stopping llama-server |
| `src-tauri/src/store.rs` | `workspace.json` (atomic writes), Keychain secrets, server validation |
| `src-tauri/src/example.rs` | The bundled example MCP server (`echo`, `add`) |

## How it works

- **Workspace:** servers, providers and tests live in `workspace.json` in the app data folder
  (`~/Library/Application Support/com.relay.mcp-workbench/`). Secrets (header values, env values,
  API keys, OAuth tokens) are never written there; they go to the Keychain under service
  `com.relay.mcp-workbench`.
- **Example server:** Relay's own binary is the example server. `add_example` registers a stdio
  server that runs Relay with `--example-mcp`, so it works with nothing installed.
- **Stdio `PATH`:** apps opened from Finder only get `/usr/bin:/bin`, so Relay launches servers
  with the `PATH` a login shell would have. Otherwise `npx`, `uvx` or Homebrew tools wouldn't be found.
- **Playground loop:** each `ai_step` sends the history plus the selected tools to the provider
  and returns the model's text and tool calls. The UI shows the calls, waits for approval, runs
  them through MCP and sends the results back in the next step (up to 12 rounds).
- **Local models:** llama-server runs under a small watchdog process (Relay's binary with
  `--llama-watchdog`). Relay holds the watchdog's stdin; when Relay exits for any reason,
  including a crash, macOS closes it and the watchdog stops the model server, so it never runs on alone.
- **Tests:** a test is a saved tool call plus optional text. It passes when the call doesn't
  return an error and the response contains that text.
