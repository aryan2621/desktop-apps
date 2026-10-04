import { useState } from "react";
import { Plus, Trash2, X, Terminal, Globe, LockKeyhole } from "lucide-react";
import { api } from "./api";
import { type Server } from "./types";
// Splits a command line the way a shell would for plain words and quotes.
function splitArgs(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null,
    quote = "";
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + ch;
  }
  if (quote) throw Error("Arguments have an unclosed quote.");
  if (word !== null) out.push(word);
  return out;
}
function parseArgs(text: string): string[] {
  if (!text.trim().startsWith("[")) return splitArgs(text);
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string"))
    throw Error("Arguments must be a JSON array of strings.");
  return parsed;
}
const showArgs = (args: string[]) =>
  args.some((a) => !a || /[\s"']/.test(a))
    ? JSON.stringify(args)
    : args.join(" ");
export default function ServerEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Server;
  onClose: () => void;
  onSave: (s: Server) => void;
}) {
  const [server, setServer] = useState(initial),
    [args, setArgs] = useState(showArgs(initial.args)),
    [rows, setRows] = useState(
      initial.headers.map((name) => ({ name, value: "" })),
    ),
    [env, setEnv] = useState(initial.env.map((name) => ({ name, value: "" }))),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const field = (key: keyof Server, value: unknown) =>
    setServer((s) => ({ ...s, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      let command = server.command.trim(),
        parsed = parseArgs(args);
      // A whole command line pasted into Executable, e.g. "npx -y @scope/server".
      // Absolute paths are left alone: they may contain spaces.
      if (
        server.transport === "stdio" &&
        /\s/.test(command) &&
        !command.startsWith("/") &&
        !parsed.length
      ) {
        [command, ...parsed] = splitArgs(command);
      }
      const secrets: Record<string, string> = {};
      rows.forEach((r) => {
        if (r.name.trim()) secrets[`header:${r.name.trim()}`] = r.value;
      });
      env.forEach((r) => {
        if (r.name.trim()) secrets[`env:${r.name.trim()}`] = r.value;
      });
      const saved = await api<Server>("save_server", {
        server: {
          ...server,
          command,
          args: parsed,
          headers: rows.map((r) => r.name.trim()).filter(Boolean),
          env: env.map((r) => r.name.trim()).filter(Boolean),
        },
        secrets,
      });
      onSave(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const pairs = (
    items: typeof rows,
    set: (v: typeof rows) => void,
    label: string,
  ) => (
    <div className="pairs">
      {items.map((r, i) => (
        <div className="pair" key={i}>
          <input
            aria-label={`${label} name ${i + 1}`}
            placeholder={label === "Header" ? "Authorization" : "VARIABLE_NAME"}
            value={r.name}
            onChange={(e) =>
              set(
                items.map((x, n) =>
                  n === i ? { ...x, name: e.target.value } : x,
                ),
              )
            }
          />
          <input
            aria-label={`${label} value ${i + 1}`}
            type="password"
            autoComplete="off"
            placeholder={initial.id ? "Unchanged if blank" : "Value"}
            value={r.value}
            onChange={(e) =>
              set(
                items.map((x, n) =>
                  n === i ? { ...x, value: e.target.value } : x,
                ),
              )
            }
          />
          <button
            className="icon-button"
            aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
            onClick={() => set(items.filter((_, n) => n !== i))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        className="text-button"
        onClick={() => set([...items, { name: "", value: "" }])}
      >
        <Plus size={14} /> Add {label.toLowerCase()}
      </button>
    </div>
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-title"
      >
        <header>
          <div>
            <span className="eyebrow">CONNECTION PROFILE</span>
            <h2 id="server-title">
              {initial.id ? "Edit server" : "Connect a new server"}
            </h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <label>
            Server name
            <input
              autoFocus
              placeholder="e.g. Development API"
              value={server.name}
              onChange={(e) => field("name", e.target.value)}
            />
          </label>
          <label>Transport</label>
          <div className="segmented">
            <button
              className={server.transport === "http" ? "selected" : ""}
              onClick={() => field("transport", "http")}
            >
              <Globe size={16} /> Streamable HTTP
            </button>
            <button
              className={server.transport === "stdio" ? "selected" : ""}
              onClick={() => field("transport", "stdio")}
            >
              <Terminal size={16} /> Local process · stdio
            </button>
          </div>
          {server.transport === "http" ? (
            <>
              <label>
                Server URL
                <input
                  placeholder="https://example.com/mcp"
                  value={server.url}
                  onChange={(e) => field("url", e.target.value)}
                />
              </label>
              <p className="hint">
                Connect to a localhost or remote MCP endpoint. Legacy SSE
                endpoints are not supported.
              </p>
              <label>
                Authentication & custom headers{" "}
                <span className="optional">optional</span>
              </label>
              {pairs(rows, setRows, "Header")}
              <p className="hint">
                Use Authorization: Bearer … or your server’s API-key header.
                OAuth browser sign-in is not included yet; paste a valid access
                token instead.
              </p>
            </>
          ) : (
            <>
              <label>
                Executable
                <input
                  placeholder="npx"
                  value={server.command}
                  onChange={(e) => field("command", e.target.value)}
                />
              </label>
              <label>
                Arguments <span className="optional">optional</span>
                <textarea
                  className="code"
                  rows={3}
                  placeholder="-y @modelcontextprotocol/server-everything"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <label>
                Working directory <span className="optional">optional</span>
                <input
                  placeholder="/Users/you/projects/server"
                  value={server.cwd}
                  onChange={(e) => field("cwd", e.target.value)}
                />
              </label>
              <label>Environment variables</label>
              {pairs(env, setEnv, "Variable")}
              <p className="hint">
                Relay runs this command when you connect, finding it the same
                way your terminal does (npx, uvx, node and Homebrew tools work).
              </p>
            </>
          )}
          <div className="notice">
            <LockKeyhole size={16} /> Header values and environment variables
            are stored in macOS Keychain.
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer>
          <button className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="button primary"
            onClick={save}
            disabled={busy || !server.name.trim()}
          >
            {busy ? "Saving…" : "Save server"}
          </button>
        </footer>
      </section>
    </div>
  );
}
