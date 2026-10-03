import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Brain, Check, Download, Keyboard, Loader2, Mic, PartyPopper, Play, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd, Panel } from "@/components/bits";
import { api, events, type Reply, type Voice } from "@/lib/api";
import type { useAppState } from "@/hooks/use-app";
import { cn } from "@/lib/utils";

const STEPS = ["Welcome", "Permissions", "Downloads", "Voice", "Try it", "Done"] as const;
/** Survives the restart Jarvis does when Accessibility is granted, so setup resumes there. */
const STEP_KEY = "jarvis.setupStep";
const SPEECH_MB = 547;

const savedStep = () => {
  try {
    const n = Number(localStorage.getItem(STEP_KEY));
    return Number.isInteger(n) && n > 0 && n < STEPS.length ? n : 0;
  } catch {
    return 0;
  }
};
const saveStep = (n: number | null) => {
  try {
    if (n === null) localStorage.removeItem(STEP_KEY);
    else localStorage.setItem(STEP_KEY, String(n));
  } catch {
    /* storage unavailable: setup just starts from the top next time */
  }
};

const formatSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

/** Re-reads the app state on an interval while a step waits for something outside the app. */
function usePoll(refresh: () => void, ms = 1500) {
  useEffect(() => {
    const id = window.setInterval(refresh, ms);
    return () => window.clearInterval(id);
  }, [refresh, ms]);
}

/** First-run setup: permissions, the two models, a voice, and a first question. */
export default function Setup({ app, onDone }: { app: ReturnType<typeof useAppState>; onDone: () => void }) {
  const { state } = app;
  const [step, setStep] = useState(savedStep);
  const go = (n: number) => {
    setStep(n);
    saveStep(n);
  };

  const finish = async () => {
    try {
      await api.finishSetup();
    } catch (e) {
      toast.error(`Couldn't save: ${e}`);
      return;
    }
    saveStep(null);
    onDone();
  };

  if (!state) return null;
  const key = state.hotkeys.find((h) => h.id === state.config.hotkey)?.label.split(" ").at(-1) ?? "⌥";
  const name = state.config.assistant_name || "Jarvis";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <div data-tauri-drag-region className="flex h-12 shrink-0 items-center justify-end px-4">
        {step < STEPS.length - 1 && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={finish}>
            Skip setup
          </Button>
        )}
      </div>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[580px] px-8 pt-4 pb-16">
          <ol className="mb-8 flex items-center gap-2" aria-label="Setup progress">
            {STEPS.map((label, i) => (
              <li key={label} className="flex flex-1 flex-col gap-1.5" aria-current={i === step ? "step" : undefined}>
                <span className={cn("h-1 rounded-full transition-colors", i <= step ? "bg-primary" : "bg-border")} />
                <span className={cn("text-[11px]", i === step ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
              </li>
            ))}
          </ol>
          <div key={step} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
            {step === 0 && <Welcome name={name} onNext={() => go(1)} />}
            {step === 1 && <Permissions app={app} name={name} onBack={() => go(0)} onNext={() => go(2)} />}
            {step === 2 && <Downloads app={app} onBack={() => go(1)} onNext={() => go(3)} />}
            {step === 3 && <VoiceStep app={app} onBack={() => go(2)} onNext={() => go(4)} />}
            {step === 4 && <TryIt app={app} keyLabel={key} name={name} onBack={() => go(3)} onNext={() => go(5)} />}
            {step === 5 && <Done keyLabel={key} name={name} onFinish={finish} />}
          </div>
        </div>
      </main>
    </div>
  );
}

function StepHeader({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="font-display text-[40px] leading-[0.95] tracking-[-0.02em]">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{children}</p>
    </header>
  );
}

function Nav({ onBack, onNext, nextLabel = "Continue", nextDisabled, hint, quiet }: { onBack?: () => void; onNext: () => void; nextLabel?: string; nextDisabled?: boolean; hint?: ReactNode; quiet?: boolean }) {
  return (
    <div className="mt-6 flex items-center gap-3">
      {onBack && (
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
      )}
      <span className="flex-1 text-right text-xs text-muted-foreground">{hint}</span>
      <Button variant={quiet ? "outline" : "default"} onClick={onNext} disabled={nextDisabled}>
        {nextLabel} <ArrowRight />
      </Button>
    </div>
  );
}

/** A row with a status on the right: done ✓, or an action. */
function Item({ icon, title, description, done, doneLabel, action, children }: { icon: ReactNode; title: string; description: ReactNode; done: boolean; doneLabel: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-5 py-4 not-last:border-b">
      <div className="flex items-center gap-4">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-[10px]", done ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>
          {done ? <Check className="size-[18px]" strokeWidth={2.5} /> : icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {done ? (
          <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-400">
            {doneLabel}
          </Badge>
        ) : (
          action
        )}
      </div>
      {children}
    </div>
  );
}

function Welcome({ name, onNext }: { name: string; onNext: () => void }) {
  return (
    <>
      <div className="mb-6 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600 shadow-lg shadow-blue-500/25">
        <Sparkles className="size-7 text-white" strokeWidth={2.25} />
      </div>
      <StepHeader title={<>Meet {name}<span className="text-muted-foreground/60">.</span></>}>
        Ask anything out loud and hear the answer. Everything — your voice, the AI and the replies — runs on this Mac, so nothing you say leaves it. Setup takes
        a couple of minutes.
      </StepHeader>
      <Nav onNext={onNext} nextLabel="Set up" />
    </>
  );
}

function Permissions({ app, name, onBack, onNext }: { app: ReturnType<typeof useAppState>; name: string; onBack: () => void; onNext: () => void }) {
  const { state, refresh } = app;
  usePoll(refresh);
  if (!state) return null;
  const { accessibility, microphone } = state.permissions;
  const micDone = microphone === "granted";
  return (
    <>
      <StepHeader title="Two permissions">macOS asks for these once. {name} restarts by itself after Accessibility is turned on, and comes back to this step.</StepHeader>
      <Panel className="overflow-hidden">
        <Item
          icon={<Keyboard className="size-[18px]" />}
          title="Accessibility"
          description={`Lets ${name} notice its key in any app, without it typing a character.`}
          done={accessibility}
          doneLabel="Allowed"
          action={
            <Button size="sm" onClick={() => api.openPrivacy("accessibility")}>
              Allow
            </Button>
          }
        />
        <Item
          icon={<Mic className="size-[18px]" />}
          title="Microphone"
          description="Only on while you hold the key or talk in a conversation."
          done={micDone}
          doneLabel="Allowed"
          action={
            microphone === "denied" ? (
              <Button size="sm" variant="outline" onClick={() => api.openPrivacy("microphone")}>
                Open Settings
              </Button>
            ) : (
              <Button size="sm" onClick={() => api.requestMicrophone()}>
                Allow
              </Button>
            )
          }
        />
      </Panel>
      <Nav onBack={onBack} onNext={onNext} quiet={!(accessibility && micDone)} nextLabel={accessibility && micDone ? "Continue" : "Continue anyway"} />
    </>
  );
}

function Downloads({ app, onBack, onNext }: { app: ReturnType<typeof useAppState>; onBack: () => void; onNext: () => void }) {
  const { state, refresh } = app;
  // Live progress from events; the poll catches up after a restart or a missed event.
  const [live, setLive] = useState<Partial<Record<"speech" | "brain", number | null>>>({});
  usePoll(refresh, 2000);
  useEffect(() => {
    const un = events.downloadProgress(({ model, progress }) => {
      setLive((l) => ({ ...l, [model]: progress }));
      if (progress === null) refresh();
    });
    const unErr = events.downloadError((m) => toast.error(`Download failed — ${m}. Check your connection and try again.`));
    return () => {
      un.then((u) => u());
      unErr.then((u) => u());
    };
  }, [refresh]);
  if (!state) return null;
  const s = state.setup;
  const progress = (model: "speech" | "brain") => (model in live ? live[model] : s.downloads[model]) ?? null;
  const speech = progress("speech");
  const brain = progress("brain");
  const busy = speech !== null || brain !== null;
  const ready = s.speech_ready && s.brain_ready;
  const remaining = (s.speech_ready ? 0 : SPEECH_MB) + (s.brain_ready ? 0 : s.brain_size_mb);

  return (
    <>
      <StepHeader title="Download the models">
        {ready ? "Both models are on this Mac." : `About ${formatSize(remaining)}, once. After that ${state.config.assistant_name || "Jarvis"} works offline.`}
      </StepHeader>
      <Panel className="overflow-hidden">
        <Item icon={<AudioLines className="size-[18px]" />} title="Speech recognition" description={`Whisper, to understand what you say · ${formatSize(SPEECH_MB)}`} done={s.speech_ready} doneLabel="Ready">
          {!s.speech_ready && speech !== null && <ProgressBar value={speech} />}
        </Item>
        <Item icon={<Brain className="size-[18px]" />} title="AI brain" description={`${s.brain_label}, to think of the answers · ${formatSize(s.brain_size_mb)}`} done={s.brain_ready} doneLabel="Ready">
          {!s.brain_ready && brain !== null && <ProgressBar value={brain} />}
        </Item>
      </Panel>
      {!ready && (
        <Button className="mt-4 w-full" disabled={busy} onClick={() => api.downloadModels().then(refresh)}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          {busy ? "Downloading… you can keep this window open" : `Download (${formatSize(remaining)})`}
        </Button>
      )}
      <Nav onBack={onBack} onNext={onNext} quiet={!ready} nextLabel={ready ? "Continue" : "Continue anyway"} hint={!ready && busy ? "Downloads keep going in the background" : undefined} />
    </>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="mt-3 flex items-center gap-3 pl-13">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

const languageName = (locale: string) => {
  try {
    return new Intl.DisplayNames([], { type: "language" }).of(locale.replace("_", "-")) ?? locale;
  } catch {
    return locale;
  }
};

function VoiceStep({ app, onBack, onNext }: { app: ReturnType<typeof useAppState>; onBack: () => void; onNext: () => void }) {
  const { state, setState } = app;
  // English voices, Indian and British first: the ones that suit an assistant best.
  const voices = useMemo(() => {
    const order = ["en_IN", "en_GB", "en_US", "en_AU", "en_IE", "en_ZA"];
    const rank = (v: Voice) => (order.includes(v.locale) ? order.indexOf(v.locale) : order.length);
    return (state?.voices ?? []).filter((v) => v.locale.startsWith("en_")).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [state?.voices]);
  if (!state) return null;
  const c = state.config;
  const pick = async (v: Voice) => {
    const config = { ...c, voice: v.name };
    setState((s) => (s ? { ...s, config } : s));
    api.previewVoice(v.name, c.speech_rate);
    await api.saveConfig(config).catch((e) => toast.error(`Couldn't save: ${e}`));
  };
  return (
    <>
      <StepHeader title="Pick a voice">Click one to hear it. You can change it, or download more natural voices, any time in Settings.</StepHeader>
      <div className="grid max-h-[340px] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {voices.map((v) => {
          const active = v.name === c.voice;
          return (
            <button
              key={v.name}
              onClick={() => pick(v)}
              className={cn(
                "flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-lift transition-colors",
                active ? "border-primary ring-2 ring-primary/30" : "hover:border-foreground/20",
              )}
            >
              <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                {active ? <Check className="size-4" /> : <Play className="size-3.5" />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{v.name.split(" (")[0]}</span>
                <span className="block truncate text-xs text-muted-foreground">{languageName(v.locale)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <Nav onBack={onBack} onNext={onNext} />
    </>
  );
}

function TryIt({ app, keyLabel, name, onBack, onNext }: { app: ReturnType<typeof useAppState>; keyLabel: string; name: string; onBack: () => void; onNext: () => void }) {
  const { state } = app;
  const [reply, setReply] = useState<Reply | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const un = events.reply(setReply);
    const unErr = events.replyError((m) => toast.error(m));
    return () => {
      un.then((u) => u());
      unErr.then((u) => u());
    };
  }, []);
  const worked = reply?.state === "done";
  const notReady = state && !(state.setup.speech_ready && state.setup.brain_ready);
  const ask = async () => {
    const q = draft.trim();
    if (!q) return;
    setDraft("");
    setReply({ state: "thinking", question: q, reply: "" });
    await api.ask(q).catch((e) => toast.error(String(e)));
  };
  return (
    <>
      <StepHeader title="Ask your first question">
        Hold <Kbd>{keyLabel}</Kbd> anywhere, say “What can you do?”, then let go. Or type it below.
      </StepHeader>
      <Panel className="overflow-hidden">
        <div className="min-h-28 px-5 py-4">
          {reply ? (
            <>
              <p className="text-[13px] text-muted-foreground">“{reply.question}”</p>
              <p className="mt-1.5 text-[15px] leading-relaxed whitespace-pre-wrap">{reply.state === "thinking" ? <span className="animate-pulse text-muted-foreground">Thinking…</span> : reply.reply}</p>
              {worked && (
                <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3.5" /> It works
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{notReady ? "Waiting for the downloads to finish…" : `Waiting for your question — ${name} will answer out loud.`}</p>
          )}
        </div>
        <div className="flex gap-2 border-t px-3 py-3">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} placeholder="Or type a question…" className="border-0 shadow-none focus-visible:ring-0" />
          <Button size="icon" onClick={ask} disabled={!draft.trim()} aria-label="Ask">
            <ArrowRight />
          </Button>
        </div>
      </Panel>
      <Nav onBack={onBack} onNext={onNext} quiet={!worked} nextLabel={worked ? "Continue" : "Skip"} />
    </>
  );
}

function Done({ keyLabel, name, onFinish }: { keyLabel: string; name: string; onFinish: () => void }) {
  const tips: [ReactNode, string][] = [
    [<Kbd key="h">hold {keyLabel}</Kbd>, "Ask a quick question; let go to get the answer"],
    [<Kbd key="t">tap {keyLabel}</Kbd>, "Start a conversation; pause and it answers, then listens again"],
    [<Kbd key="e">esc</Kbd>, "Stop it talking, or end a conversation"],
  ];
  return (
    <>
      <div className="mb-6 grid size-14 place-items-center rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <PartyPopper className="size-7" />
      </div>
      <StepHeader title={<>{name} is ready<span className="text-muted-foreground/60">.</span></>}>It lives in the menu bar. Three things to remember:</StepHeader>
      <Panel className="overflow-hidden">
        {tips.map(([k, text], i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-3.5 not-last:border-b">
            <span className="w-24 shrink-0">{k}</span>
            <span className="text-sm">{text}</span>
          </div>
        ))}
      </Panel>
      <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" /> Everything stays on this Mac.
      </div>
      <Nav onNext={onFinish} nextLabel={`Open ${name}`} />
    </>
  );
}
