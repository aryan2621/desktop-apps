import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const executablePath =
  process.env.CHROME_PATH ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
  ].find(existsSync);
if (!executablePath)
  throw Error("Set CHROME_PATH to an installed Chromium browser.");
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1320, height: 860 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const workspace = {
      servers: [],
      providers: [{ id: "local", model: "qwen3-4b", baseUrl: "" }],
      tests: [],
    };
    const tools = [
      {
        name: "echo",
        description:
          "Echo a message back. Useful for checking connectivity and model tool calls.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "add",
        description: "Add two numbers and return the sum.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    ];
    window.__calls = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args = {}) => {
        window.__calls.push({ command, args });
        if (command.startsWith("plugin:event|")) return 1;
        if (command === "load_workspace")
          return JSON.parse(JSON.stringify(workspace));
        if (command === "model_catalog")
          return [
            {
              id: "qwen3-4b",
              name: "Qwen3 4B Instruct",
              sizeMb: 2382,
              installed: false,
              quantization: "Q4_K_M",
              repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
            },
          ];
        if (command === "add_example") {
          const s = {
            id: "example",
            name: "Relay example",
            transport: "stdio",
            command: "/Applications/Relay.app/Contents/MacOS/relay",
            args: ["--example-mcp"],
            cwd: "",
            url: "",
            headers: [],
            env: [],
          };
          workspace.servers.push(s);
          return s;
        }
        if (command === "save_server") {
          const s = { ...args.server, id: args.server.id || "remote" };
          workspace.servers = workspace.servers.filter((x) => x.id !== s.id);
          workspace.servers.push(s);
          return s;
        }
        if (command === "connect_server")
          return {
            info: {
              serverInfo: { name: "example", version: "1" },
              capabilities: { tools: {} },
            },
            tools,
          };
        if (command === "call_tool") {
          if (args.arguments.message === "fail")
            throw Error("Fixture tool failed");
          return {
            content: [
              {
                type: "text",
                text:
                  args.arguments.message ??
                  String(args.arguments.a + args.arguments.b),
              },
            ],
          };
        }
        if (command === "save_test") {
          const t = { ...args.test, id: "test-1" };
          workspace.tests.push(t);
          return t;
        }
        if (command === "save_provider") {
          workspace.providers = workspace.providers.filter(
            (p) => p.id !== args.provider.id,
          );
          workspace.providers.push(args.provider);
          return null;
        }
        if (command === "ai_step") {
          if (args.input)
            return {
              text: "I’ll use the echo tool.",
              calls: [
                {
                  id: "call-1",
                  name: "tool_1",
                  arguments: { message: "Hello Relay" },
                },
              ],
              history: [{ role: "user", content: args.input }],
              usage: {},
            };
          return {
            text: "The tool returned Hello Relay.",
            calls: [],
            history: [...args.history, { role: "assistant", content: "Done" }],
            usage: {},
          };
        }
        if (command === "server_catalog") return [];
        if (
          command === "disconnect_server" ||
          command === "delete_server" ||
          command === "delete_test"
        )
          return null;
        throw Error(`Unexpected command: ${command}`);
      },
    };
  });
  await page.goto("http://127.0.0.1:1428");
  await page
    .getByRole("heading", { name: "A home for your MCP servers." })
    .waitFor();
  await page.screenshot({ path: "/tmp/relay-home.png" });
  await page.getByRole("button", { name: "Add your first server" }).click();
  await page.getByLabel("Server name").fill("Staging MCP");
  await page.getByLabel("Server URL").fill("https://example.com/mcp");
  await page.getByRole("button", { name: "Add header", exact: true }).click();
  await page.getByLabel("Header name 1").fill("X-API-Key");
  await page.getByLabel("Header value 1").fill("test-key");
  await page.getByRole("button", { name: "Save server", exact: true }).click();
  await page
    .getByRole("heading", { name: "Staging MCP", exact: true })
    .waitFor();
  const saved = await page.evaluate(() =>
    window.__calls.find((c) => c.command === "save_server"),
  );
  assert.equal(saved.args.secrets["header:X-API-Key"], "test-key");
  assert.deepEqual(saved.args.server.headers, ["X-API-Key"]);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".server-card .badge.success").waitFor();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.getByRole("button", { name: /echo Echo a message/ }).click();
  await page.getByLabel("Request arguments").fill('{"message":"Hello Relay"}');
  await page.getByRole("button", { name: "Run tool", exact: true }).click();
  await page
    .locator(".result-code")
    .filter({ hasText: "Hello Relay" })
    .waitFor();
  await page.getByLabel("Expected response text").fill("Hello Relay");
  await page.getByRole("button", { name: "Save test", exact: true }).click();
  await page.screenshot({ path: "/tmp/relay-inspector.png" });
  await page.getByRole("button", { name: "Saved tests", exact: true }).click();
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await page.locator(".test-pass").waitFor();
  await page
    .getByRole("button", { name: "AI Playground", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /echo/ }).check();
  await page.getByLabel("Message", { exact: true }).fill("Echo Hello Relay");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("button", { name: "Approve & run", exact: true })
    .waitFor();
  const before = await page.evaluate(
    () => window.__calls.filter((c) => c.command === "call_tool").length,
  );
  await page.screenshot({ path: "/tmp/relay-playground.png" });
  assert.equal(before, 2, "AI must wait for approval before executing");
  await page
    .getByRole("button", { name: "Approve & run", exact: true })
    .click();
  await page
    .getByText("The tool returned Hello Relay.", { exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => window.__calls.filter((c) => c.command === "call_tool").length,
    ),
    3,
  );
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.getByLabel("Request arguments").fill('{"message":"fail"}');
  await page.getByRole("button", { name: "Run tool", exact: true }).click();
  await page
    .locator(".result-code")
    .filter({ hasText: "Fixture tool failed" })
    .waitFor();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.locator(".trace .badge.failure").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: server auth configuration, connect, inspect, execute, saved test, AI approval, tool errors, activity.",
  );
} finally {
  await browser.close();
}
