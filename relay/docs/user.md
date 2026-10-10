# Relay: user guide

[← Back to README](../README.md) · [Developer guide](dev.md)

- [Install](#install) · [Servers](#servers) · [Inspector](#inspector) · [Playground](#playground)
- [Models](#models) · [Tests](#tests) · [Activity](#activity) · [Your data](#your-data) · [Troubleshooting](#troubleshooting)

## Install

1. Download [`Relay_0.1.0_aarch64.dmg`](https://github.com/aryan2621/dev-tools/releases/latest/download/Relay_0.1.0_aarch64.dmg)
   (macOS 12 or later, Apple silicon).
2. Open it, drag **Relay** into **Applications**, and open Relay.

**Windows** (10 or later): run [`Relay_0.1.0_x64-setup.exe`](https://github.com/aryan2621/dev-tools/releases/latest/download/Relay_0.1.0_x64-setup.exe).
Secrets go to the Windows Credential Manager instead of the Keychain, and on-device models aren't
available yet: use an API key provider in the Playground.

**"Apple could not verify Relay is free of malware":** Relay isn't signed with a paid Apple
Developer certificate, so macOS warns you the first time. Click **Done**, open **System Settings →
Privacy & Security**, scroll down, click **Open Anyway** next to Relay and confirm. If macOS says
Relay **"is damaged and can't be opened"**, run this once in Terminal and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Relay.app
```

## Servers

Your MCP servers, local and remote. **Try the example server** adds a small built-in one
(`echo` and `add` tools) so you can try everything before connecting your own.

**Add a connection** and choose a transport:

| Transport | You fill in | Example |
|---|---|---|
| **stdio** (local process) | Command, arguments, working folder, environment variables | `npx` · `-y @modelcontextprotocol/server-filesystem ~/Documents` |
| **HTTP** (Streamable HTTP) | URL and headers | `https://example.com/mcp` · `Authorization: Bearer …` |

- Commands are found the way your terminal finds them, so `npx`, `uvx`, `node` and anything from
  Homebrew or nvm work even though Relay was opened from Finder.
- Header and environment variable **values are stored in the macOS Keychain**, never in Relay's
  files. Put credentials in headers, not in the URL.
- Servers that use MCP's OAuth show **Sign in**: your browser opens, you sign in, and Relay keeps
  the tokens in the Keychain and renews them by itself. **Sign out** forgets them.

## Inspector

Pick a connected server to see its **tools**, **resources** and **prompts**.

- A tool shows its description, its input **JSON Schema** and whether it says it's read-only.
- Fill in the **Request arguments** and click **Run tool**. The **Response** shows the
  result, how long it took, and whether the server called it an error.
- Resources can be read and prompts fetched with their arguments the same way.
- **log** (stdio servers) shows the last 4 KB the server printed to stderr: the first place to look
  when it won't start. Servers log there because stdout carries the MCP protocol.
- **Keep this as a test** saves the request to **Tests**, with optional text the response must contain.

## Playground

See how a model uses your tools. Choose a model, choose which tools to share (only the selected
ones are sent), and give it a task.

- Every tool call **waits for your approval**: you see the tool and its arguments, then **Approve & run**
  or **Decline**. Declined calls are reported back to the model. A task stops after 12 rounds of tool calls.
- Tool results, the model's replies and token usage appear step by step.
- Models:
  - **On this Mac:** downloaded from the **Models** page; free, private, no account.
  - **With an API key:** **Claude** (Anthropic), **OpenAI** (GPT models) or **Gemini** (Google).
    Keys are stored in the Keychain. Requests go straight from your Mac to that provider.

## Models

Models that run on your Mac with the built-in llama.cpp (4-bit, native tool calling). Relay
recommends the strongest one your Mac's memory runs comfortably.

| Model | Download | Memory | Good for |
|---|---|---|---|
| Qwen3.5 4B | 2.7 GB | 8 GB | Small and quick; simple, single tool calls |
| Qwen3.5 9B | 5.7 GB | 16 GB | The best balance of speed and accuracy for multi-step tool use |
| Gemma 4 12B | 6.7 GB | 16 GB | Checking your tools work beyond one model family |
| Gemma 4 26B A4B | 14.3 GB | 32 GB | Large but fast |
| Qwen3.8 27B | 16.5 GB | 32 GB | The most capable, close to cloud models at tool use; slower |

Downloads come from Hugging Face and can be cancelled. The model stops when Relay quits, even
after a crash or force quit.

## Tests

Saved tool requests. A test passes when the tool doesn't return an error and, if you gave one,
its response contains your expected text. **Run all** after you change your server: each test
connects its server if needed and shows pass or fail. A server that needs
a sign-in asks you to sign in from **Servers** first.

## Activity

Every call made from the Inspector, Playground or Tests: tool and server, status, duration and
time. Open one to see its arguments and response.

## Your data

- Servers, providers and tests: `~/Library/Application Support/com.relay.mcp-workbench/workspace.json`
- Downloaded models: the `models/` folder next to it
- Header values, environment variables, API keys and sign-in tokens: the macOS Keychain
  (service `com.relay.mcp-workbench`)

Nothing is sent anywhere except to the MCP servers you connect, the AI provider you choose, and
Hugging Face for model downloads.

## Troubleshooting

- **A stdio server won't connect:** open the Inspector's **log** tab to see its error. Check the command
  runs in Terminal.
- **macOS asks for Keychain access:** click **Always Allow** so it doesn't ask on every request.
- **A local model is slow:** pick a smaller one on **Models**, or close other large apps.
