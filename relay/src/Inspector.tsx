import { useEffect, useState } from "react";
import {
  Braces,
  Play,
  Save,
  Search,
  FileText,
  MessageSquare,
  Copy,
  Check,
  ScrollText,
  RefreshCw,
} from "lucide-react";
import { api } from "./api";
import {
  type Server,
  type Connection,
  type Trace,
  type TestCase,
  type Tool,
  pretty,
  parseObject,
} from "./types";
export default function Inspector({
  servers,
  connections,
  run,
  onTest,
  onError,
}: {
  servers: Server[];
  connections: Record<string, Connection>;
  run: (id: string, name: string, args: unknown) => Promise<Trace>;
  onTest: (t: TestCase) => void;
  onError: (e: unknown) => void;
}) {
  const [id, setId] = useState(""),
    [tab, setTab] = useState("tools"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState(""),
    [args, setArgs] = useState("{}"),
    [result, setResult] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [duration, setDuration] = useState<number | null>(null),
    [testName, setTestName] = useState(""),
    [contains, setContains] = useState(""),
    [copied, setCopied] = useState(false);
  const [catalog, setCatalog] = useState<Record<string, unknown>[]>([]),
    [log, setLog] = useState("");
  const ids = Object.keys(connections),
    activeId = connections[id] ? id : (ids[0] ?? ""),
    connection = connections[activeId];
  const tools = connection?.tools ?? [];
  const stdio = servers.find((s) => s.id === activeId)?.transport === "stdio";
  if (tab === "log" && !stdio && connection) setTab("tools");
  const loadLog = () =>
    api<string>("server_log", { id: activeId }).then(setLog).catch(onError);
  const tool = tools.find((t) => t.name === selected);
  useEffect(() => {
    setSelected("");
    setSearch("");
    setResult(null);
    setArgs("{}");
    setCatalog([]);
  }, [activeId, tab]);
  useEffect(() => {
    let cancelled = false;
    if (tab === "log" && activeId) void loadLog();
    if (activeId && (tab === "resources" || tab === "prompts")) {
      setBusy(true);
      api<Record<string, unknown>[]>("server_catalog", {
        id: activeId,
        kind: tab,
      })
        .then((v) => {
          if (!cancelled) setCatalog(v);
        })
        .catch((e) => {
          if (!cancelled) onError(e);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [activeId, tab]);
  const select = (t: Tool) => {
    setSelected(t.name);
    setResult(null);
    setDuration(null);
    const initial: Record<string, unknown> = {};
    Object.entries(t.inputSchema.properties ?? {}).forEach(([k, v]) => {
      if (t.inputSchema.required?.includes(k))
        initial[k] =
          v.default ??
          (v.type === "number" || v.type === "integer"
            ? 0
            : v.type === "boolean"
              ? false
              : v.type === "array"
                ? []
                : v.type === "object"
                  ? {}
                  : "");
    });
    setArgs(pretty(initial));
    setTestName(t.name);
  };
  const execute = async () => {
    setBusy(true);
    setResult(null);
    try {
      const a = parseObject(args);
      if (tab === "tools") {
        const trace = await run(activeId, selected, a);
        setResult(trace.result);
        setDuration(trace.duration);
      } else {
        const start = performance.now();
        setResult(
          await api(tab === "resources" ? "read_resource" : "get_prompt", {
            id: activeId,
            name: selected,
            uri: selected,
            arguments: a,
          }),
        );
        setDuration(Math.round(performance.now() - start));
      }
    } catch (e) {
      setResult({ error: String(e) });
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    try {
      const test = await api<TestCase>("save_test", {
        test: {
          id: "",
          name: testName || selected,
          serverId: activeId,
          tool: selected,
          arguments: parseObject(args),
          contains,
        },
      });
      onTest(test);
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="inspector panel">
      <div className="inspector-toolbar">
        <div className="tab-buttons">
          {[
            { id: "tools", icon: Braces },
            { id: "resources", icon: FileText },
            { id: "prompts", icon: MessageSquare },
            ...(stdio ? [{ id: "log", icon: ScrollText }] : []),
          ].map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              disabled={busy}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={15} />
              {t.id}
            </button>
          ))}
        </div>
        <select
          aria-label="Inspector server"
          value={activeId}
          disabled={busy}
          onChange={(e) => setId(e.target.value)}
        >
          {!ids.length && <option value="">No connected servers</option>}
          {ids.map((i) => (
            <option key={i} value={i}>
              {servers.find((s) => s.id === i)?.name ?? i}
            </option>
          ))}
        </select>
      </div>
      {!connection ? (
        <div className="empty">
          <Braces size={34} />
          <h2>Your tools, under the microscope.</h2>
          <p>
            Connect a server to inspect its tools, resources, and prompts.
            <br />
            You don’t need an AI model to get started.
          </p>
        </div>
      ) : tab === "log" ? (
        <div className="server-log">
          <div className="result-heading">
            <p className="hint">
              What the server printed to stderr (last 4 KB). Servers log here
              because stdout carries the MCP protocol.
            </p>
            <button className="button small" onClick={() => void loadLog()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          <pre className="result-code">
            {log || "The server hasn’t printed anything yet."}
          </pre>
        </div>
      ) : (
        <div className="inspector-grid">
          <aside className="tool-list">
            <div className="search">
              <Search size={15} />
              <input
                aria-label="Search tools"
                placeholder={`Find ${tab}…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="list-caption">
              {tab === "tools" ? tools.length : catalog.length} {tab}
            </div>
            {tab === "tools"
              ? tools
                  .filter((t) =>
                    t.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((t) => (
                    <button
                      key={t.name}
                      className={`tool-row ${selected === t.name ? "active" : ""}`}
                      onClick={() => select(t)}
                      disabled={busy}
                    >
                      <Braces size={15} />
                      <div>
                        <strong>{t.name}</strong>
                        <span>
                          {t.description || "No description provided"}
                        </span>
                      </div>
                    </button>
                  ))
              : catalog
                  .filter((t) =>
                    String(t.name ?? t.uri)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((t, i) => (
                    <button
                      key={i}
                      className={`tool-row ${selected === String(t.uri ?? t.name) ? "active" : ""}`}
                      disabled={busy}
                      onClick={() => {
                        setSelected(String(t.uri ?? t.name));
                        // Prompts list their arguments; start with every one filled in blank.
                        const params = Array.isArray(t.arguments)
                          ? (t.arguments as { name: string }[])
                          : [];
                        setArgs(
                          pretty(
                            Object.fromEntries(params.map((a) => [a.name, ""])),
                          ),
                        );
                        setDuration(null);
                        setResult(null);
                      }}
                    >
                      <FileText size={15} />
                      <div>
                        <strong>{String(t.name ?? t.uri)}</strong>
                        <span>{String(t.description ?? "")}</span>
                      </div>
                    </button>
                  ))}
            {!(tab === "tools" ? tools.length : catalog.length) && (
              <p className="hint padded">
                {busy ? "Discovering…" : `No ${tab} advertised by this server.`}
              </p>
            )}
          </aside>
          <section className="tool-detail">
            {!selected ? (
              <div className="empty compact">
                <Braces size={26} />
                <h3>
                  Select a{" "}
                  {tab === "tools"
                    ? "tool"
                    : tab === "resources"
                      ? "resource"
                      : "prompt"}
                </h3>
                <p>Inspect the schema and run a request.</p>
              </div>
            ) : (
              <>
                <div className="tool-heading">
                  <div>
                    <span className="eyebrow">
                      {tab === "tools"
                        ? "TOOLS / CALL"
                        : tab === "resources"
                          ? "RESOURCES / READ"
                          : "PROMPTS / GET"}
                    </span>
                    <h2>{selected}</h2>
                    <p>{tool?.description}</p>
                  </div>
                  {tool?.annotations?.readOnlyHint === true && (
                    <span className="badge">Read-only hint</span>
                  )}
                </div>
                {tool && (
                  <details className="schema">
                    <summary>
                      Input schema <span>JSON Schema</span>
                    </summary>
                    <pre>{pretty(tool.inputSchema)}</pre>
                  </details>
                )}
                {tab !== "resources" && (
                  <>
                    <div className="section-label">
                      <label htmlFor="tool-arguments">Request arguments</label>
                      <span className="mono">JSON</span>
                    </div>
                    <textarea
                      id="tool-arguments"
                      className="code args-editor"
                      spellCheck={false}
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      disabled={busy}
                    />
                  </>
                )}
                <div className="run-row">
                  <p className="hint">
                    {tab === "tools"
                      ? "This executes the tool on your connected server."
                      : "Requests are sent directly to the connected server."}
                  </p>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={execute}
                  >
                    <Play size={14} />
                    {busy
                      ? "Running…"
                      : tab === "tools"
                        ? "Run tool"
                        : tab === "resources"
                          ? "Read resource"
                          : "Get prompt"}
                  </button>
                </div>
                <div className="result-heading">
                  <h3>Response</h3>
                  <div>
                    {duration !== null && (
                      <span className="badge">{duration} ms</span>
                    )}
                    <button
                      className="icon-button"
                      aria-label="Copy response"
                      disabled={result === null}
                      onClick={() => {
                        navigator.clipboard
                          .writeText(pretty(result))
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          })
                          .catch(onError);
                      }}
                    >
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                    </button>
                  </div>
                </div>
                <pre className="result-code">
                  {result === null
                    ? "Run a request to see its response here."
                    : pretty(result)}
                </pre>
                {tab === "tools" && (
                  <div className="save-test">
                    <h3>Keep this as a test</h3>
                    <div className="test-fields">
                      <input
                        aria-label="Test name"
                        placeholder="Test name"
                        value={testName}
                        onChange={(e) => setTestName(e.target.value)}
                      />
                      <input
                        aria-label="Expected response text"
                        placeholder="Response must contain… (optional)"
                        value={contains}
                        onChange={(e) => setContains(e.target.value)}
                      />
                      <button className="button" onClick={save} disabled={busy}>
                        <Save size={14} /> Save test
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
