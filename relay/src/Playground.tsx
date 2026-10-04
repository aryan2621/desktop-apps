import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Braces,
  Check,
  ChevronDown,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  RefreshCw,
  LoaderCircle,
} from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import {
  providers,
  type Catalog,
  type Server,
  type Provider,
  type Connection,
  type Step,
  type Call,
  type ToolOutput,
  type Trace,
  pretty,
} from "./types";
// Links would navigate the app window away from Relay, and images would load from anywhere.
const markdownParts: Components = {
  a: ({ href, children }) => (
    <span className="markdown-link" title={href}>
      {children}
    </span>
  ),
  img: ({ alt }) => <>{alt}</>,
};
type BoundTool = {
  name: string;
  description: string;
  parameters: unknown;
  serverId: string;
  toolName: string;
  serverName: string;
};
type ChatMessage = { role: string; text: string; detail?: unknown };
export default function Playground({
  servers,
  connections,
  configured,
  catalog,
  visible,
  openModels,
  run,
  onError,
}: {
  servers: Server[];
  connections: Record<string, Connection>;
  configured: Provider[];
  catalog: Catalog | null;
  visible: boolean;
  openModels: () => void;
  run: (id: string, name: string, args: unknown) => Promise<Trace>;
  onError: (e: unknown) => void;
}) {
  const [providerId, setProviderId] = useState("local"),
    [loading, setLoading] = useState(""),
    [input, setInput] = useState(""),
    [off, setOff] = useState<string[]>([]),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Call[]>([]),
    [retry, setRetry] = useState<{
      input: string;
      results: ToolOutput[];
    } | null>(null),
    [showTools, setShowTools] = useState(true),
    [round, setRound] = useState(0);
  const history = useRef<unknown[]>([]),
    bound = useRef<BoundTool[]>([]),
    request = useRef(""),
    end = useRef<HTMLDivElement>(null);
  const allTools = Object.entries(connections).flatMap(([id, c]) =>
    c.tools.map((t) => ({
      key: `${id}:${t.name}`,
      serverId: id,
      toolName: t.name,
      serverName: servers.find((s) => s.id === id)?.name ?? id,
      description: t.description ?? "",
      parameters: t.inputSchema,
    })),
  );
  // Every model that's ready to use: the one picked on this Mac, and each saved API key.
  const choices = configured
    .map((p) => {
      if (p.id !== "local")
        return {
          id: p.id,
          label: `${providers.find((x) => x.id === p.id)?.name} · ${p.model}`,
        };
      const m = catalog?.models.find((m) => m.id === p.model && m.installed);
      return m && { id: p.id, label: `${m.name} · on this Mac` };
    })
    .filter((c) => !!c);
  const locked = messages.length > 0,
    provider = choices.find((c) => c.id === providerId),
    local = providerId === "local",
    localModel = configured.find((p) => p.id === "local")?.model ?? "";
  // Follow whichever model is actually set up, preferring the one on this Mac.
  useEffect(() => {
    if (!locked && !provider && choices.length) setProviderId(choices[0].id);
  }, [choices, provider, locked]);
  // Load the local model when the Playground opens, so the first reply doesn't wait for it.
  useEffect(() => {
    if (!visible || !local || !provider || !localModel) return;
    let cancelled = false;
    setLoading(localModel);
    api("warm_model", { id: localModel })
      .catch((e) => !cancelled && onError(e))
      .finally(() => !cancelled && setLoading(""));
    return () => {
      cancelled = true;
    };
  }, [visible, local, !!provider, localModel, onError]);
  const add = (m: ChatMessage) => {
    setMessages((v) => [...v, m]);
    setTimeout(
      () => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }),
      40,
    );
  };
  const step = async (text: string, results: ToolOutput[] = []) => {
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setRetry(null);
    try {
      const r = await api<Step>("ai_step", {
        requestId: id,
        providerId,
        history: history.current,
        input: text,
        results,
        tools: bound.current.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      });
      history.current = r.history;
      setPending(r.calls);
      setRound((n) => n + 1);
      if (r.text) add({ role: "assistant", text: r.text });
      if (!r.text && !r.calls.length)
        add({
          role: "assistant",
          text: "The model returned no text or tool calls.",
        });
    } catch (e) {
      onError(e);
      setRetry({ input: text, results });
      add({ role: "error", text: String(e) });
    } finally {
      setBusy(false);
      request.current = "";
    }
  };
  const send = async () => {
    if (!input.trim() || busy || pending.length || retry) return;
    const text = input.trim();
    setInput("");
    if (!locked) {
      // Show the model real tool names (providers allow [A-Za-z0-9_-], up to 64),
      // with a suffix when two servers have a tool of the same name.
      const used = new Set<string>();
      bound.current = allTools
        .filter((t) => !off.includes(t.key))
        .map((t) => {
          const base =
            t.toolName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "tool";
          let name = base;
          for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
          used.add(name);
          return {
            ...t,
            name,
            description: `${t.serverName} / ${t.toolName}: ${t.description}`,
          };
        });
    }
    add({ role: "user", text });
    await step(text);
  };
  const approve = async (allow: boolean) => {
    setBusy(true);
    const calls = [...pending];
    setPending([]);
    const outputs: ToolOutput[] = [];
    for (const c of calls) {
      const t = bound.current.find((t) => t.name === c.name);
      let value: unknown;
      if (!allow) value = { error: "The user declined this tool call." };
      else if (!t)
        value = { error: "The model requested a tool that was not enabled." };
      else {
        try {
          const trace = await run(t.serverId, t.toolName, c.arguments);
          value = trace.result;
        } catch (e) {
          value = { error: String(e) };
        }
      }
      add({
        role: "tool",
        text: `${allow ? "Executed" : "Declined"} ${t?.toolName ?? c.name}`,
        detail: value,
      });
      outputs.push({ id: c.id, content: pretty(value) });
    }
    await step("", outputs);
  };
  const reset = () => {
    history.current = [];
    bound.current = [];
    setMessages([]);
    setPending([]);
    setRetry(null);
    setRound(0);
  };
  return (
    <div className="playground panel">
      <div className="playground-top">
        <div className="inline">
          <Sparkles size={17} />
          {choices.length ? (
            <select
              aria-label="Model"
              value={providerId}
              disabled={locked || busy}
              onChange={(e) => setProviderId(e.target.value)}
            >
              {choices.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <button className="text-button" onClick={openModels}>
              Set up a model
            </button>
          )}
          {local && loading && (
            <span className="model-label">
              <LoaderCircle size={13} className="spin" /> Loading model…
            </span>
          )}
        </div>
        <button className="button small" disabled={busy} onClick={reset}>
          <RotateCcw size={14} /> New session
        </button>
      </div>
      <div className="playground-body">
        <div className="chat">
          <div className="chat-messages">
            {!messages.length ? (
              <div className="chat-welcome">
                <h2>How does a model use your tools?</h2>
                {choices.length ? (
                  <>
                    <p>
                      Give the model a task that needs your tools. You approve
                      every tool call before it runs.
                    </p>
                    <div className="suggestions">
                      {[
                        "What can the connected tools do?",
                        "Try each tool once with sensible inputs.",
                      ].map((t) => (
                        <button key={t} onClick={() => setInput(t)}>
                          {t}
                          <ArrowUp size={14} />
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      First pick a model: download one to run free on this Mac,
                      or add an API key.
                    </p>
                    <button className="button primary" onClick={openModels}>
                      Set up a model
                    </button>
                  </>
                )}
              </div>
            ) : (
              messages.map((m, i) => (
                <article key={i} className={`chat-message ${m.role}`}>
                  <span className="message-role">
                    {m.role === "user"
                      ? "You"
                      : m.role === "assistant"
                        ? "Model"
                        : m.role === "tool"
                          ? "Tool result"
                          : "Request failed"}
                  </span>
                  {m.role === "assistant" ? (
                    <div className="markdown">
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownParts}
                      >
                        {m.text}
                      </Markdown>
                    </div>
                  ) : (
                    <div>{m.text}</div>
                  )}
                  {m.detail !== undefined && (
                    <details>
                      <summary>View result</summary>
                      <pre>{pretty(m.detail)}</pre>
                    </details>
                  )}
                </article>
              ))
            )}
            {busy && (
              <div className="thinking">
                <span className="pulse" />{" "}
                {local && loading ? "Loading the model…" : "Thinking…"}
              </div>
            )}
            {!!pending.length && (
              <section className="approval">
                <div className="inline">
                  <ShieldCheck size={18} />
                  <strong>
                    Review {pending.length} tool{" "}
                    {pending.length === 1 ? "call" : "calls"}
                  </strong>
                </div>
                <p>
                  The model wants to execute these requests on your servers.
                </p>
                {pending.map((c) => (
                  <div className="pending-call" key={c.id}>
                    <strong>
                      {bound.current.find((t) => t.name === c.name)?.toolName ??
                        c.name}
                    </strong>
                    <span>
                      {bound.current.find((t) => t.name === c.name)?.serverName}
                    </span>
                    <pre>{pretty(c.arguments)}</pre>
                  </div>
                ))}
                <div className="inline">
                  <button
                    className="button"
                    disabled={busy || round >= 12}
                    onClick={() => approve(false)}
                  >
                    <X size={14} /> Decline
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || round >= 12}
                    onClick={() => approve(true)}
                  >
                    <Check size={14} /> Approve & run
                  </button>
                </div>
                {round >= 12 && (
                  <p className="hint">
                    The session reached its 12-response limit. Start a new
                    session to continue.
                  </p>
                )}
              </section>
            )}
            {retry && !busy && (
              <div className="retry">
                <p>
                  Retry the model request using the same recorded tool results.
                  Tools will not be executed again.
                </p>
                <button
                  className="button"
                  onClick={() => step(retry.input, retry.results)}
                >
                  <RefreshCw size={14} /> Retry request
                </button>
              </div>
            )}
            <div ref={end} />
          </div>
          <div className="composer-wrap">
            <div className="composer">
              <textarea
                aria-label="Message"
                placeholder={
                  provider
                    ? "Give your tools something to work on…"
                    : "Download a model or add an API key in Models to start…"
                }
                value={input}
                disabled={busy || !!pending.length || !!retry || round >= 12}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {busy ? (
                <button
                  className="send-button"
                  aria-label="Stop generation"
                  onClick={() => {
                    if (request.current)
                      void api("cancel_request", { id: request.current }).catch(
                        onError,
                      );
                  }}
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="Send message"
                  disabled={
                    !provider ||
                    !input.trim() ||
                    !!pending.length ||
                    !!retry ||
                    round >= 12
                  }
                  onClick={send}
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
            <div className="composer-caption">
              <span>
                {local
                  ? "Runs on this Mac · nothing is sent to an AI service"
                  : "Your messages and tool results are sent to your provider"}
              </span>
              <span>↵ Send</span>
            </div>
          </div>
        </div>
        <aside className="playground-tools">
          <button
            className="tools-title"
            onClick={() => setShowTools(!showTools)}
          >
            <span>
              <Braces size={16} /> Available tools
            </span>
            <ChevronDown size={15} />
          </button>
          <p>Only selected tools are shared with the model.</p>
          {showTools && (
            <>
              {allTools.length === 0 ? (
                <div className="hint">
                  Connect an MCP server to make its tools available here.
                </div>
              ) : (
                allTools.map((t) => (
                  <label className="tool-checkbox" key={t.key}>
                    <input
                      type="checkbox"
                      checked={!off.includes(t.key)}
                      disabled={locked}
                      onChange={(e) =>
                        // Tools start enabled; remember only the ones switched off.
                        setOff((v) =>
                          e.target.checked
                            ? v.filter((k) => k !== t.key)
                            : [...v, t.key],
                        )
                      }
                    />
                    <span>
                      <strong>{t.toolName}</strong>
                      <small>{t.serverName}</small>
                    </span>
                  </label>
                ))
              )}
            </>
          )}
          {locked && (
            <p className="hint">
              Start a new session to change the model or tool selection.
            </p>
          )}
          <div className="approval-note">
            <ShieldCheck size={17} />
            <strong>You’re in control</strong>
            <p>Tool calls require your approval before they run.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
