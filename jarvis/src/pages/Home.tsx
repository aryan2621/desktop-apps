import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, XAxis } from "recharts";
import { ArrowRight, ArrowUp, Gauge, MessageSquarePlus, ShieldAlert, Sparkles, Square } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Textarea } from "@/components/ui/textarea";
import { EntryRow } from "@/components/entry-row";
import { EmptyState, Kbd, PageHeader, Panel, SectionTitle } from "@/components/bits";
import { api, events, formatSeconds, type Reply } from "@/lib/api";
import { medianResponseMs, questionsPerDay, streak } from "@/lib/metrics";
import { useAppState, useHistory } from "@/hooks/use-app";
import { cn } from "@/lib/utils";
import type { Tab } from "@/App";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

const spark: ChartConfig = { value: { label: "Questions", color: "var(--chart-1)" } };

export default function Home({ app, goTo }: { app: ReturnType<typeof useAppState>; goTo: (t: Tab) => void }) {
  const { entries } = useHistory("", 100_000);
  const [live, setLive] = useState<Reply | null>(null);
  const [draft, setDraft] = useState("");
  const replyRef = useRef<HTMLDivElement>(null);
  const s = app.state;
  const perms = s?.permissions;
  const key = s?.hotkeys.find((h) => h.id === s.config.hotkey)?.label.split(" ").at(-1) ?? "⌥";
  const name = s?.config.assistant_name || "Jarvis";
  const usesOllama = s?.config.brain === "ollama";
  const modelMissing = usesOllama && s?.ollama.running && !s.ollama.models.includes(s.config.llm_model);

  const week = useMemo(() => questionsPerDay(entries ?? [], 7), [entries]);
  const days = useMemo(() => streak(entries ?? []), [entries]);
  const speed = useMemo(() => medianResponseMs((entries ?? []).slice(0, 50)), [entries]);
  const today = week.at(-1)?.value ?? 0;

  // Answers stream in here whether they were spoken, held or typed.
  useEffect(() => {
    const un = events.reply((r) => setLive(r));
    const unErr = events.replyError((m) => {
      toast.error(m);
      setLive(null);
    });
    return () => {
      un.then((u) => u());
      unErr.then((u) => u());
    };
  }, []);

  useEffect(() => {
    replyRef.current?.scrollTo({ top: replyRef.current.scrollHeight });
  }, [live?.reply]);

  const busy = live && live.state !== "done";

  async function ask() {
    const q = draft.trim();
    if (!q) return;
    setDraft("");
    setLive({ state: "thinking", question: q, reply: "" });
    try {
      await api.ask(q);
    } catch (e) {
      toast.error(String(e));
      setLive(null);
    }
  }

  const date = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  return (
    <>
      <PageHeader eyebrow={date} title={<>{greeting()}<span className="text-muted-foreground/60">.</span></>} />

      {perms && !perms.accessibility && (
        <Alert className="mb-4 rounded-xl">
          <ShieldAlert />
          <AlertTitle>Allow Accessibility</AlertTitle>
          <AlertDescription>Needed so {name} can catch its key from any app.</AlertDescription>
          <AlertAction>
            <Button size="sm" onClick={() => api.openPrivacy("accessibility")}>Open Settings</Button>
          </AlertAction>
        </Alert>
      )}
      {perms?.microphone === "denied" && (
        <Alert className="mb-4 rounded-xl">
          <ShieldAlert />
          <AlertTitle>Allow Microphone</AlertTitle>
          <AlertDescription>{name} can't hear you. Turn it on in Privacy &amp; Security.</AlertDescription>
          <AlertAction>
            <Button size="sm" onClick={() => api.openPrivacy("microphone")}>Open Settings</Button>
          </AlertAction>
        </Alert>
      )}
      {s && !usesOllama && !(s.setup.speech_ready && s.setup.brain_ready) && (
        <Alert className="mb-4 rounded-xl">
          <ShieldAlert />
          <AlertTitle>Finish setting up {name}</AlertTitle>
          <AlertDescription>{s.setup.brain_ready ? "The speech model" : "The AI model"} isn't downloaded yet.</AlertDescription>
        </Alert>
      )}
      {s && usesOllama && !s.ollama.running && (
        <Alert className="mb-4 rounded-xl">
          <ShieldAlert />
          <AlertTitle>Ollama isn't running</AlertTitle>
          <AlertDescription>
            {name} thinks with Ollama on this Mac. Open the Ollama app, or run <code data-selectable className="rounded bg-muted px-1">brew services start ollama</code>.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => app.refresh()}>Check again</Button>
          </AlertAction>
        </Alert>
      )}
      {modelMissing && (
        <Alert className="mb-4 rounded-xl">
          <ShieldAlert />
          <AlertTitle>Model “{s.config.llm_model}” isn't installed</AlertTitle>
          <AlertDescription>
            Run <code data-selectable className="rounded bg-muted px-1">ollama pull {s.config.llm_model}</code>, or pick an installed model in Settings.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => goTo("settings")}>Settings</Button>
          </AlertAction>
        </Alert>
      )}

      {/* Hero: today's questions with a 7-day sparkline, and how fast answers come back. */}
      <div className="grid grid-cols-[1.65fr_1fr] gap-4">
        <div className="relative overflow-hidden rounded-2xl bg-lavender p-6 text-lavender-foreground">
          <div className="text-xs font-medium tracking-wide uppercase opacity-70">Today</div>
          <div className="mt-2 font-display text-[76px] leading-[0.85] tracking-[-0.03em] tabular-nums">{today.toLocaleString()}</div>
          <div className="mt-2 text-sm opacity-80">
            question{today === 1 ? "" : "s"} asked
            {days > 1 && <span className="opacity-80"> · {days}-day streak</span>}
          </div>
          <ChartContainer config={spark} className="mt-4 aspect-auto h-20 w-full">
            <AreaChart data={week} margin={{ left: 2, right: 2, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="weekday" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }} interval={0} padding={{ left: 14, right: 14 }} />
              <ChartTooltip
                cursor={{ stroke: "currentColor", strokeOpacity: 0.25 }}
                content={({ active, payload }) => {
                  const p = active && payload?.[0]?.payload;
                  return p ? (
                    <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                      <span className="font-medium">{p.value} question{p.value === 1 ? "" : "s"}</span> · {p.label}
                    </div>
                  ) : null;
                }}
              />
              <Area dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} fill="url(#spark-fill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--lavender)" }} />
            </AreaChart>
          </ChartContainer>
        </div>

        <div className="flex flex-col justify-between rounded-2xl bg-forest p-6 text-forest-foreground">
          <div className="flex items-center gap-2 text-xs font-medium tracking-wide uppercase opacity-75">
            <Gauge className="size-3.5" /> Response time
          </div>
          <div>
            <div className="font-display text-[64px] leading-[0.85] tracking-[-0.03em] tabular-nums">{speed ? formatSeconds(speed) : "–"}</div>
            <div className="mt-1.5 text-sm opacity-80">from your last word to its first</div>
          </div>
          <div className="border-t border-white/15 pt-3 text-xs">
            <span className="font-display text-2xl leading-none">{s ? (usesOllama ? s.config.llm_model : s.setup.brain_label) : "–"}</span>
            <span className="ml-2 opacity-70">on this Mac</span>
          </div>
        </div>
      </div>

      <SectionTitle
        action={
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 text-muted-foreground"
            onClick={async () => {
              await api.newConversation();
              setLive(null);
              toast("New conversation — earlier questions are forgotten");
            }}
          >
            <MessageSquarePlus /> New conversation
          </Button>
        }
      >
        Ask {name}
      </SectionTitle>
      <Panel className="overflow-hidden">
        <div className="flex items-center gap-2 border-b px-5 py-3 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" />
          Type below, or hold <Kbd>{key}</Kbd> to ask out loud and tap it for a conversation.
        </div>
        {live && (
          <div className="border-b px-5 py-4">
            <p data-selectable className="text-[13px] text-muted-foreground">“{live.question}”</p>
            <div ref={replyRef} data-selectable className="mt-1.5 max-h-56 overflow-y-auto text-[15px] leading-relaxed whitespace-pre-wrap">
              {live.state === "thinking" ? <span className="animate-pulse text-muted-foreground">Thinking…</span> : live.reply}
            </div>
          </div>
        )}
        <div className="flex items-end gap-2 px-3 py-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask();
              }
            }}
            rows={1}
            placeholder={`Ask ${name} anything…`}
            className="max-h-32 min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          {busy ? (
            <Button size="icon" variant="outline" aria-label="Stop" onClick={() => api.stop().then(() => setLive((l) => (l ? { ...l, state: "done" } : l)))}>
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button size="icon" aria-label="Ask" disabled={!draft.trim()} onClick={ask} className={cn(!draft.trim() && "opacity-40")}>
              <ArrowUp />
            </Button>
          )}
        </div>
      </Panel>

      <SectionTitle
        action={
          <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground" onClick={() => goTo("history")}>
            View all <ArrowRight />
          </Button>
        }
      >
        Recent
      </SectionTitle>
      <Panel className="overflow-hidden">
        {entries === null ? null : entries.length ? (
          entries.slice(0, 3).map((e) => <EntryRow key={e.time} entry={e} />)
        ) : (
          <EmptyState title="Nothing yet">Hold {key} anywhere and ask {name} a question.</EmptyState>
        )}
      </Panel>
    </>
  );
}
