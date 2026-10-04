import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Beaker,
  Braces,
  Check,
  ChevronRight,
  CircleHelp,
  Ellipsis,
  FlaskConical,
  Globe,
  LoaderCircle,
  LogIn,
  LogOut,
  Network,
  Play,
  Plug,
  Plus,
  Radio,
  Search,
  Cpu,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { api } from "./api";
import {
  type Server,
  type Workspace,
  type Connection,
  type Trace,
  type TestCase,
  type Catalog,
  type Provider,
  emptyServer,
  pretty,
} from "./types";
import ServerEditor from "./ServerEditor";
import Inspector from "./Inspector";
import Playground from "./Playground";
import Models from "./Models";

const navigation = [
  { id: "servers", name: "Servers", icon: Network },
  { id: "inspector", name: "Inspector", icon: Braces },
  { id: "playground", name: "Playground", icon: Sparkles },
  { id: "tests", name: "Tests", icon: FlaskConical },
  { id: "activity", name: "Activity", icon: Activity },
];
const pageInfo: Record<string, [string, string]> = {
  servers: ["Servers", "Your MCP servers, local and remote."],
  inspector: [
    "Inspector",
    "Call tools, read resources and get prompts, directly.",
  ],
  playground: [
    "Playground",
    "Watch a model use your tools. You approve every call.",
  ],
  tests: ["Tests", "Saved requests to re-run whenever your server changes."],
  activity: ["Activity", "Every tool call made this session."],
  models: [
    "Models",
    "The AI the Playground uses: on this Mac, or with your API key.",
  ],
};
/** connect_server's error when the server wants a browser sign-in (OAuth). */
const SIGN_IN_REQUIRED = "SIGN_IN_REQUIRED";
export default function App() {
  const [page, setPage] = useState("servers"),
    [workspace, setWorkspace] = useState<Workspace>({
      servers: [],
      providers: [],
      tests: [],
    }),
    [connections, setConnections] = useState<Record<string, Connection>>({}),
    [connecting, setConnecting] = useState<string[]>([]),
    [signingIn, setSigningIn] = useState<string[]>([]),
    [serverErrors, setServerErrors] = useState<Record<string, string>>({}),
    [editor, setEditor] = useState<Server | null>(null),
    [traces, setTraces] = useState<Trace[]>([]),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [search, setSearch] = useState(""),
    [testResults, setTestResults] = useState<
      Record<string, { pass: boolean; detail: string }>
    >({}),
    [testBusy, setTestBusy] = useState(""),
    [confirmDelete, setConfirmDelete] = useState<Server | null>(null),
    [help, setHelp] = useState(false),
    [ready, setReady] = useState(false),
    [catalog, setCatalog] = useState<Catalog | null>(null);
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const onError = useCallback(
    (e: unknown) => notify(String(e), true),
    [notify],
  );
  useEffect(() => {
    api<Workspace>("load_workspace")
      .then((w) => {
        setWorkspace(w);
        setReady(true);
      })
      .catch(onError);
    api<Catalog>("model_catalog").then(setCatalog).catch(onError);
  }, [onError]);
  const refreshCatalog = useCallback(
    () => api<Catalog>("model_catalog").then(setCatalog),
    [],
  );
  const saveProvider = (p: Provider) =>
    setWorkspace((w) => ({
      ...w,
      providers: [...w.providers.filter((x) => x.id !== p.id), p],
    }));
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 12000 : 4500);
    return () => clearTimeout(t);
  }, [toast]);
  /** Connects a server; resolves to its error, or "" when it connected. */
  const connect = async (s: Server): Promise<string> => {
    setConnecting((v) => [...v, s.id]);
    setServerErrors((v) => ({ ...v, [s.id]: "" }));
    try {
      const c = await api<Connection>("connect_server", { id: s.id });
      setConnections((v) => ({ ...v, [s.id]: c }));
      notify(`${s.name} connected · ${c.tools.length} tools discovered`);
      return "";
    } catch (e) {
      setServerErrors((v) => ({ ...v, [s.id]: String(e) }));
      setConnections((v) => {
        const n = { ...v };
        delete n[s.id];
        return n;
      });
      if (String(e) !== SIGN_IN_REQUIRED) onError(e);
      return String(e);
    } finally {
      setConnecting((v) => v.filter((id) => id !== s.id));
    }
  };
  const signIn = async (s: Server) => {
    setSigningIn((v) => [...v, s.id]);
    try {
      await api("sign_in_server", { id: s.id });
    } catch (e) {
      setSigningIn((v) => v.filter((id) => id !== s.id));
      if (String(e) !== "Sign-in cancelled.") onError(e);
      return;
    }
    setSigningIn((v) => v.filter((id) => id !== s.id));
    await connect(s);
  };
  const signOut = async (s: Server) => {
    try {
      await api("sign_out_server", { id: s.id });
      setConnections((v) => {
        const n = { ...v };
        delete n[s.id];
        return n;
      });
      notify(`Signed out of ${s.name}`);
    } catch (e) {
      onError(e);
    }
  };
  const disconnect = async (s: Server) => {
    try {
      await api("disconnect_server", { id: s.id });
      setConnections((v) => {
        const n = { ...v };
        delete n[s.id];
        return n;
      });
    } catch (e) {
      onError(e);
    }
  };
  const saveServer = (s: Server) => {
    setWorkspace((w) => ({
      ...w,
      servers: [...w.servers.filter((x) => x.id !== s.id), s],
    }));
    setConnections((v) => {
      const n = { ...v };
      delete n[s.id];
      return n;
    });
    setEditor(null);
    notify("Server profile saved");
  };
  const run = async (
    id: string,
    name: string,
    args: unknown,
  ): Promise<Trace> => {
    const start = performance.now();
    let result: unknown,
      error = false;
    try {
      result = await api("call_tool", { id, name, arguments: args });
      error = !!(result as { isError?: boolean })?.isError;
    } catch (e) {
      result = { error: String(e) };
      error = true;
      // The server process died; show it as disconnected so the user can reconnect.
      if (String(e).includes("connection closed"))
        setConnections((v) => {
          const n = { ...v };
          delete n[id];
          return n;
        });
    }
    const trace: Trace = {
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString(),
      server: workspace.servers.find((s) => s.id === id)?.name ?? id,
      name,
      arguments: args,
      result,
      duration: Math.round(performance.now() - start),
      error,
    };
    setTraces((v) => [trace, ...v].slice(0, 200));
    return trace;
  };
  const addExample = async () => {
    try {
      const s = await api<Server>("add_example");
      setWorkspace((w) => ({ ...w, servers: [...w.servers, s] }));
      await connect(s);
    } catch (e) {
      onError(e);
    }
  };
  /** Runs a saved test, connecting its server first if needed. `tried` carries the servers a
   * "Run all" already connected (or failed to), which this render's state doesn't show yet:
   * server id → its connect error, "" when it connected. */
  const runTest = async (t: TestCase, tried = new Map<string, string>()) => {
    setTestBusy(t.id);
    try {
      if (!connections[t.serverId]) {
        const server = workspace.servers.find((s) => s.id === t.serverId);
        if (!server) throw Error("This test's server was deleted.");
        if (!tried.has(server.id)) tried.set(server.id, await connect(server));
        const error = tried.get(server.id);
        if (error)
          throw Error(
            error === SIGN_IN_REQUIRED
              ? `${server.name} needs you to sign in. Sign in from Servers, then run the test again.`
              : `Could not connect ${server.name}: ${error}`,
          );
      }
      const r = await run(t.serverId, t.tool, t.arguments);
      // Match against what the tool said, not its JSON-escaped form.
      const content = (r.result as { content?: { text?: string }[] })?.content;
      const text = Array.isArray(content)
        ? content.map((c) => c.text ?? "").join("\n")
        : "";
      const pass =
        !r.error &&
        (!t.contains ||
          text.includes(t.contains) ||
          pretty(r.result).includes(t.contains));
      setTestResults((v) => ({
        ...v,
        [t.id]: {
          pass,
          detail: r.error
            ? pretty(r.result)
            : pass
              ? `Passed in ${r.duration} ms`
              : `Response did not contain “${t.contains}”.`,
        },
      }));
    } catch (e) {
      setTestResults((v) => ({
        ...v,
        [t.id]: { pass: false, detail: String(e) },
      }));
    } finally {
      setTestBusy("");
    }
  };
  const runAll = async () => {
    const tried = new Map<string, string>();
    for (const t of workspace.tests) await runTest(t, tried);
  };
  const connected = Object.keys(connections).length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-space" data-tauri-drag-region />
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("servers");
          }}
        >
          <div className="brand-mark">
            <Radio size={16} />
          </div>
          <span>Relay</span>
        </a>
        <nav>
          {navigation.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "active" : ""}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={18} />
              <span>{n.name}</span>
              {n.id === "servers" && (
                <span className="nav-count">{workspace.servers.length}</span>
              )}
            </button>
          ))}
        </nav>
        <nav className="nav-secondary">
          <button
            className={page === "models" ? "active" : ""}
            onClick={() => setPage("models")}
          >
            <Cpu size={18} />
            <span>Models</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="help-link" onClick={() => setHelp(true)}>
            <CircleHelp size={16} /> Getting started <ArrowRight size={14} />
          </button>
        </div>
      </aside>
      <main>
        <div className="topbar" data-tauri-drag-region>
          <span className="topbar-status">
            <span className={`status-dot ${connected ? "" : "muted"}`} />
            {connected} connected
          </span>
        </div>
        <div className="page-content">
          <header className="page-header">
            <div>
              <h1>{pageInfo[page][0]}</h1>
              <p>{pageInfo[page][1]}</p>
            </div>
            {page === "servers" && (
              <div className="inline">
                <button
                  className="button primary"
                  disabled={!ready}
                  onClick={() => setEditor(emptyServer())}
                >
                  <Plus size={16} /> Add server
                </button>
              </div>
            )}
            {page === "tests" && (
              <button
                className="button"
                disabled={!workspace.tests.length || !!testBusy}
                onClick={runAll}
              >
                <Play size={16} /> Run all
              </button>
            )}
            {page === "activity" && (
              <button
                className="button"
                disabled={!traces.length}
                onClick={() => setTraces([])}
              >
                Clear activity
              </button>
            )}
          </header>
          <section hidden={page !== "servers"}>
            <div className="section-heading">
              <span />
              <div className="search">
                <Search size={16} />
                <input
                  aria-label="Search servers"
                  placeholder="Search servers…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            {!workspace.servers.length ? (
              <div className="server-empty panel">
                <h2>Connect your first MCP server</h2>
                <p>
                  A local command (stdio) or a remote endpoint (Streamable
                  HTTP). Not sure yet? The example server works right away.
                </p>
                <div className="inline">
                  <button
                    className="button primary"
                    disabled={!ready}
                    onClick={() => setEditor(emptyServer())}
                  >
                    <Plus size={15} /> Add server
                  </button>
                  <button
                    className="button"
                    disabled={!ready}
                    onClick={addExample}
                  >
                    <Beaker size={15} /> Try the example server
                  </button>
                </div>
              </div>
            ) : (
              <div className="server-grid">
                {workspace.servers
                  .filter((s) =>
                    s.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((s) => {
                    const c = connections[s.id],
                      loading = connecting.includes(s.id),
                      waiting = signingIn.includes(s.id),
                      needsSignIn = serverErrors[s.id] === SIGN_IN_REQUIRED,
                      failed = !!serverErrors[s.id] && !needsSignIn;
                    return (
                      <article className="server-card panel" key={s.id}>
                        <div className="server-card-top">
                          <div className={`server-icon ${s.transport}`}>
                            {s.transport === "stdio" ? (
                              <Terminal size={21} />
                            ) : (
                              <Globe size={21} />
                            )}
                          </div>
                          <div className="server-card-menu">
                            <span
                              className={`badge ${c ? "success" : failed ? "failure" : ""}`}
                            >
                              <span
                                className={`status-dot ${c ? "" : failed ? "red" : "muted"}`}
                              />
                              {loading
                                ? "Connecting"
                                : c
                                  ? "Connected"
                                  : needsSignIn
                                    ? "Sign-in required"
                                    : failed
                                      ? "Connection failed"
                                      : "Disconnected"}
                            </span>
                            <button
                              className="icon-button"
                              aria-label={`Edit ${s.name}`}
                              disabled={loading || waiting}
                              onClick={() => setEditor(s)}
                            >
                              <Ellipsis size={18} />
                            </button>
                          </div>
                        </div>
                        <h3>{s.name}</h3>
                        <p
                          className="server-address"
                          title={s.transport === "stdio" ? s.command : s.url}
                        >
                          {s.transport === "stdio" ? s.command : s.url}
                        </p>
                        <div className="server-meta">
                          <span>
                            {s.transport === "stdio" ? "STDIO" : "HTTP"}
                          </span>
                          <span>
                            <Braces size={13} />
                            {c ? `${c.tools.length} tools` : "Not inspected"}
                          </span>
                          {!!s.headers.length && <ShieldCheck size={14} />}
                        </div>
                        {failed && (
                          <p className="server-error">{serverErrors[s.id]}</p>
                        )}
                        {needsSignIn && (
                          <p className="server-notice">
                            {waiting
                              ? "Finish signing in in your browser, then come back here."
                              : "This server needs you to sign in. Relay opens its sign-in page in your browser."}
                          </p>
                        )}
                        <footer>
                          {needsSignIn && !c && !loading ? (
                            <button
                              className="button small primary"
                              disabled={waiting}
                              onClick={() => signIn(s)}
                            >
                              {waiting ? (
                                <LoaderCircle className="spin" size={14} />
                              ) : (
                                <LogIn size={14} />
                              )}{" "}
                              {waiting ? "Waiting for browser…" : "Sign in"}
                            </button>
                          ) : (
                            <button
                              className={`button small ${c ? "" : "primary"}`}
                              disabled={loading}
                              onClick={() => (c ? disconnect(s) : connect(s))}
                            >
                              {loading ? (
                                <LoaderCircle className="spin" size={14} />
                              ) : c ? (
                                <Unplug size={14} />
                              ) : (
                                <Plug size={14} />
                              )}{" "}
                              {loading
                                ? "Connecting…"
                                : c
                                  ? "Disconnect"
                                  : "Connect"}
                            </button>
                          )}
                          {waiting ? (
                            <button
                              className="text-button"
                              onClick={() =>
                                api("cancel_sign_in", { id: s.id }).catch(
                                  onError,
                                )
                              }
                            >
                              Cancel
                            </button>
                          ) : c ? (
                            <div className="inline">
                              {c.signedIn && (
                                <button
                                  className="text-button"
                                  onClick={() => signOut(s)}
                                >
                                  <LogOut size={14} /> Sign out
                                </button>
                              )}
                              <button
                                className="text-button"
                                onClick={() => setPage("inspector")}
                              >
                                Inspect <ArrowRight size={14} />
                              </button>
                            </div>
                          ) : (
                            <button
                              className="icon-button"
                              aria-label={`Delete ${s.name}`}
                              disabled={loading}
                              onClick={() => setConfirmDelete(s)}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </footer>
                      </article>
                    );
                  })}
                <button
                  className="add-server-card"
                  onClick={() => setEditor(emptyServer())}
                >
                  <div>
                    <Plus size={21} />
                  </div>
                  <strong>Add a connection</strong>
                  <span>Local process or remote endpoint</span>
                </button>
              </div>
            )}
          </section>
          <section hidden={page !== "inspector"}>
            <Inspector
              servers={workspace.servers}
              connections={connections}
              run={run}
              onTest={(t) => {
                setWorkspace((w) => ({
                  ...w,
                  tests: [...w.tests.filter((x) => x.id !== t.id), t],
                }));
                notify("Test saved");
              }}
              onError={onError}
            />
          </section>
          <section hidden={page !== "playground"}>
            <Playground
              servers={workspace.servers}
              connections={connections}
              configured={workspace.providers}
              catalog={catalog}
              visible={page === "playground"}
              openModels={() => setPage("models")}
              run={run}
              onError={onError}
            />
          </section>
          <section hidden={page !== "models"}>
            <Models
              catalog={catalog}
              refresh={refreshCatalog}
              configured={workspace.providers}
              onProvider={saveProvider}
              notify={notify}
              onError={onError}
            />
          </section>
          <section hidden={page !== "tests"}>
            {!workspace.tests.length ? (
              <div className="panel empty">
                <FlaskConical size={34} />
                <h2>Your next regression starts here.</h2>
                <p>
                  Save a tool request from the Inspector, with an optional
                  expected response.
                  <br />
                  Run it again whenever your server changes.
                </p>
                <button className="button" onClick={() => setPage("inspector")}>
                  Open Inspector <ArrowRight size={14} />
                </button>
              </div>
            ) : (
              <div className="tests-list">
                {workspace.tests.map((t) => (
                  <div className="panel test-card" key={t.id}>
                    <div className="test-card-main">
                      <FlaskConical size={22} />
                      <div>
                        <h3>{t.name}</h3>
                        <p>
                          {
                            workspace.servers.find((s) => s.id === t.serverId)
                              ?.name
                          }{" "}
                          <ChevronRight size={12} /> <code>{t.tool}</code>
                        </p>
                      </div>
                      <button
                        className="button"
                        disabled={!!testBusy}
                        onClick={() => runTest(t)}
                      >
                        {testBusy === t.id ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <Play size={14} />
                        )}{" "}
                        Run test
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete test ${t.name}`}
                        disabled={!!testBusy}
                        onClick={async () => {
                          try {
                            await api("delete_test", { id: t.id });
                            setWorkspace((w) => ({
                              ...w,
                              tests: w.tests.filter((x) => x.id !== t.id),
                            }));
                          } catch (e) {
                            onError(e);
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <details>
                      <summary>Request & expectation</summary>
                      <pre>{pretty(t.arguments)}</pre>
                      <p>
                        {t.contains
                          ? `Response contains: ${t.contains}`
                          : "Expect a successful tool response."}
                      </p>
                    </details>
                    {testResults[t.id] && (
                      <div
                        className={
                          testResults[t.id].pass ? "test-pass" : "error"
                        }
                      >
                        {testResults[t.id].pass ? (
                          <Check size={15} />
                        ) : (
                          <X size={15} />
                        )}{" "}
                        {testResults[t.id].detail}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section hidden={page !== "activity"}>
            {!traces.length ? (
              <div className="panel empty">
                <Activity size={34} />
                <h2>Every request has a story.</h2>
                <p>
                  Run a tool in the Inspector or Playground to see its
                  arguments,
                  <br />
                  response, duration, and outcome here.
                </p>
              </div>
            ) : (
              <div className="panel activity-list">
                <div className="activity-labels">
                  <span>TOOL / SERVER</span>
                  <span>STATUS</span>
                  <span>DURATION</span>
                  <span>TIME</span>
                </div>
                {traces.map((t) => (
                  <details key={t.id} className="trace">
                    <summary>
                      <div>
                        <Braces size={16} />
                        <span>
                          <strong>{t.name}</strong>
                          <small>{t.server}</small>
                        </span>
                      </div>
                      <span
                        className={`badge ${t.error ? "failure" : "success"}`}
                      >
                        {t.error ? "Error" : "Success"}
                      </span>
                      <span className="mono">{t.duration} ms</span>
                      <span>{t.time}</span>
                    </summary>
                    <div className="trace-details">
                      <div>
                        <h4>Arguments</h4>
                        <pre>{pretty(t.arguments)}</pre>
                      </div>
                      <div>
                        <h4>Response</h4>
                        <pre>{pretty(t.result)}</pre>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
            <p className="hint activity-hint">
              Activity stays in memory for this session. Tool output can contain
              sensitive information.
            </p>
          </section>
        </div>
      </main>
      {editor && (
        <ServerEditor
          initial={editor}
          onClose={() => setEditor(null)}
          onSave={saveServer}
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <span>{toast.error ? <X size={17} /> : <Check size={17} />}</span>
          <p>{toast.text}</p>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {confirmDelete && (
        <div className="modal-backdrop">
          <section
            className="modal small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <header>
              <h2 id="delete-title">Delete {confirmDelete.name}?</h2>
            </header>
            <div className="modal-body">
              <p>
                This removes its profile, saved credentials, and associated
                tests.
              </p>
            </div>
            <footer>
              <button className="button" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="button danger-button"
                onClick={async () => {
                  try {
                    await api("delete_server", { id: confirmDelete.id });
                    setWorkspace((w) => ({
                      ...w,
                      servers: w.servers.filter(
                        (s) => s.id !== confirmDelete.id,
                      ),
                      tests: w.tests.filter(
                        (t) => t.serverId !== confirmDelete.id,
                      ),
                    }));
                    setConfirmDelete(null);
                  } catch (e) {
                    onError(e);
                  }
                }}
              >
                Delete server
              </button>
            </footer>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop">
          <section
            className="modal small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <header>
              <h2 id="help-title">Getting started with Relay</h2>
              <button
                className="icon-button"
                aria-label="Close help"
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="modal-body help-body">
              <p>
                <strong>1. Connect.</strong> Add a local stdio process or a
                Streamable HTTP endpoint. The example server is a safe first
                connection.
              </p>
              <p>
                <strong>2. Inspect.</strong> Choose a tool, review its schema,
                and send JSON arguments. Stdio servers also show their log.
              </p>
              <p>
                <strong>3. Test.</strong> Saved tests re-run your requests and
                check the response, so you notice when a change breaks a tool.
              </p>
              <p>
                <strong>4. Try it with AI.</strong> Download a model in Models
                (free, runs on this Mac) or add an API key, enable tools in the
                Playground, and approve each tool call the model makes.
              </p>
              <p className="hint">
                This release supports API keys and bearer-token headers. OAuth
                sign-in and legacy SSE endpoints are not yet supported.
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
