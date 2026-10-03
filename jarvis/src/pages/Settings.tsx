import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioLines, Brain, FolderOpen, Info, Keyboard, MessagesSquare, Mic, Play, RefreshCw, ShieldCheck, Sparkles, Volume2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { IconTile, PageHeader, Panel } from "@/components/bits";
import { api, type Config, type Voice } from "@/lib/api";
import type { useAppState } from "@/hooks/use-app";

const LANGUAGES: [string, string][] = [
  ["en", "English"], ["auto", "Detect automatically"], ["hi", "Hindi"], ["bn", "Bengali"], ["mr", "Marathi"],
  ["ta", "Tamil"], ["te", "Telugu"], ["gu", "Gujarati"], ["ur", "Urdu"], ["es", "Spanish"], ["fr", "French"],
  ["de", "German"], ["pt", "Portuguese"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
];
const SYSTEM_DEFAULT = "__default__";

const RATES: [number, string][] = [[160, "Slow"], [195, "Normal"], [230, "Fast"], [265, "Very fast"]];
const PAUSES = [1, 1.5, 2, 2.5, 3];
const TIMEOUTS: [number, string][] = [[10, "10 seconds"], [20, "20 seconds"], [30, "30 seconds"], [60, "1 minute"]];
const SENSITIVITY: [number, string][] = [[0.008, "High — quiet voice"], [0.012, "Normal"], [0.02, "Low — noisy room"], [0.03, "Very low — very noisy"]];
const FORGET: [number, string][] = [[2, "2 minutes"], [5, "5 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"]];
const KEEP_ALIVE: [string, string][] = [["5m", "5 minutes"], ["30m", "30 minutes"], ["1h", "1 hour"], ["-1", "Always"]];

function Row({ id, title, description, children, stack }: { id?: string; title: string; description: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={stack ? "flex flex-col gap-3 px-5 py-4 not-last:border-b" : "flex min-h-16 items-center gap-6 px-5 py-3.5 not-last:border-b"}>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-[13px] font-medium">{title}</Label>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Section({ icon, tint, title, children }: { icon: LucideIcon; tint: string; title: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex items-center gap-2.5 px-1">
        <IconTile icon={icon} className={tint} />
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
      </div>
      <Panel className="overflow-hidden">{children}</Panel>
    </section>
  );
}

/** A select over fixed choices that still shows a hand-edited value from config.json. */
function Choice<T extends string | number>({ id, value, options, onChange, className, format }: { id: string; value: T; options: [T, string][]; onChange: (v: T) => void; className: string; format?: (v: T) => string }) {
  const all = options.some(([v]) => v === value) ? options : [...options, [value, format ? format(value) : String(value)] as [T, string]];
  return (
    <Select value={String(value)} onValueChange={(v) => onChange((typeof value === "number" ? Number(v) : v) as T)}>
      <SelectTrigger id={id} className={className}><SelectValue /></SelectTrigger>
      <SelectContent>{all.map(([v, l]) => <SelectItem key={String(v)} value={String(v)}>{l}</SelectItem>)}</SelectContent>
    </Select>
  );
}

const languageName = (locale: string) => {
  try {
    return new Intl.DisplayNames([], { type: "language" }).of(locale.replace("_", "-")) ?? locale;
  } catch {
    return locale;
  }
};

/** Voices grouped by language, English first. */
function groupVoices(voices: Voice[]) {
  const groups = new Map<string, Voice[]>();
  for (const v of voices) {
    const lang = languageName(v.locale);
    groups.set(lang, [...(groups.get(lang) ?? []), v]);
  }
  return [...groups.entries()].sort(([a], [b]) => Number(b.startsWith("English")) - Number(a.startsWith("English")) || a.localeCompare(b));
}

const formatSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

export default function Settings({ app, onRunSetup }: { app: ReturnType<typeof useAppState>; onRunSetup: () => void }) {
  const { state, setState, refresh } = app;
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const loaded = useRef(false);

  useEffect(() => {
    if (state && !loaded.current) {
      loaded.current = true;
      setName(state.config.assistant_name);
      setPrompt(state.config.system_prompt ?? "");
    }
  }, [state]);

  const voiceGroups = useMemo(() => groupVoices(state?.voices ?? []), [state?.voices]);

  if (!state) return null;
  const c = state.config;
  const model = state.models.find((m) => m.id === c.whisper_model);
  const llmModels = state.ollama.models.includes(c.llm_model) ? state.ollama.models : [c.llm_model, ...state.ollama.models];

  async function save(patch: Partial<Config>) {
    const config = { ...state!.config, ...patch };
    setState((s) => (s ? { ...s, config } : s));
    try {
      const res = await api.saveConfig(config);
      if (res.restarting) toast(`Restarting ${config.assistant_name} with the new key…`);
      else if (res.reloading_model) {
        toast("Loading speech model — progress shows in the sidebar");
        setTimeout(refresh, 800);
      }
    } catch (e) {
      toast.error(`Couldn't save: ${e}`);
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Changes save automatically and apply right away." />

      <Section icon={Keyboard} tint="bg-blue-500" title="Shortcut">
        <Row id="hotkey" title="Assistant key" description="Hold for a quick question, tap for a conversation. Use a different key from Murmur. Changing it restarts the app.">
          <Select value={c.hotkey} onValueChange={(v) => save({ hotkey: v })}>
            <SelectTrigger id="hotkey" className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>{state.hotkeys.map((h) => <SelectItem key={h.id} value={h.id}>{h.label}</SelectItem>)}</SelectContent>
          </Select>
        </Row>
      </Section>

      <Section icon={Brain} tint="bg-violet-500" title="Brain">
        <Row
          id="brain"
          title="AI"
          description={
            c.brain === "builtin"
              ? `${state.setup.brain_label}, built into ${c.assistant_name}. ${state.setup.brain_ready ? "Downloaded and ready." : "Not downloaded yet — run setup to get it."}`
              : "Use a model from your own Ollama instead (advanced)."
          }
        >
          <Choice
            id="brain"
            className="w-44"
            value={c.brain}
            options={[
              ["builtin", "Built-in"],
              ["ollama", "Ollama"],
            ]}
            onChange={(v) => save({ brain: v })}
          />
        </Row>
        {c.brain === "ollama" && (
        <Row
          id="llm"
          title="Ollama model"
          description={state.ollama.running ? "Models installed in Ollama on this Mac. Bigger models are smarter but slower." : "Ollama isn't running, so installed models can't be listed."}
        >
          <div className="flex items-center gap-1">
            <Select value={c.llm_model} onValueChange={(v) => save({ llm_model: v })}>
              <SelectTrigger id="llm" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {llmModels.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                    {!state.ollama.models.includes(m) && <Badge variant="outline" className="ml-1">not installed</Badge>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" aria-label="Refresh models" onClick={() => refresh().then(() => toast("Models refreshed", { duration: 1200 }))}>
              <RefreshCw />
            </Button>
          </div>
        </Row>
        )}
        <Row id="name" title="Name" description="What the assistant calls itself.">
          <Input id="name" className="w-56" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== c.assistant_name && save({ assistant_name: name.trim() })} />
        </Row>
        <Row stack id="prompt" title="Personality" description="Your own instructions for how it should answer. Leave empty for the built-in one: short, spoken, no lists.">
          <Textarea
            id="prompt"
            rows={4}
            value={prompt}
            placeholder={`You are ${c.assistant_name}, a friendly assistant. Answer in one or two short sentences…`}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => (prompt.trim() || null) !== c.system_prompt && save({ system_prompt: prompt.trim() || null })}
          />
        </Row>
        <Row id="forget" title="Memory" description="Follow-up questions remember the conversation until it goes quiet for this long.">
          <Choice id="forget" className="w-44" value={c.forget_after_minutes} options={FORGET} format={(v) => `${v} minutes`} onChange={(v) => save({ forget_after_minutes: v })} />
        </Row>
        <Row id="keep" title="Keep model loaded" description="Loading takes a few seconds; while loaded it uses about 3 GB of memory.">
          <Choice id="keep" className="w-44" value={c.keep_alive} options={KEEP_ALIVE} onChange={(v) => save({ keep_alive: v })} />
        </Row>
      </Section>

      <Section icon={Volume2} tint="bg-pink-500" title="Voice">
        <Row
          id="voice"
          title="Voice"
          description={
            <>
              Built-in macOS voices. ▶ plays a sample.{" "}
              <button className="text-primary underline-offset-2 hover:underline" onClick={() => api.openVoiceSettings()}>
                Get more natural Premium voices
              </button>
            </>
          }
        >
          <div className="flex items-center gap-1">
            <Select value={c.voice} onValueChange={(v) => save({ voice: v })}>
              <SelectTrigger id="voice" className="w-60"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-80">
                {voiceGroups.map(([lang, list]) => (
                  <SelectGroup key={lang}>
                    <SelectLabel>{lang}</SelectLabel>
                    {list.map((v) => <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>)}
                  </SelectGroup>
                ))}
                {!state.voices.some((v) => v.name === c.voice) && <SelectItem value={c.voice}>{c.voice}</SelectItem>}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" aria-label="Play sample" onClick={() => api.previewVoice(c.voice, c.speech_rate)}>
              <Play />
            </Button>
          </div>
        </Row>
        <Row id="rate" title="Speed" description="How fast answers are spoken.">
          <Choice id="rate" className="w-44" value={c.speech_rate} options={RATES} format={(v) => `${v} wpm`} onChange={(v) => save({ speech_rate: v })} />
        </Row>
        <Row id="speak" title="Speak answers" description="Off: answers only appear on screen.">
          <Switch id="speak" checked={c.speak_replies} onCheckedChange={(v) => save({ speak_replies: v })} />
        </Row>
      </Section>

      <Section icon={MessagesSquare} tint="bg-emerald-500" title="Conversation">
        <Row id="pause" title="Pause before answering" description="Tap mode: how long you stay quiet before it answers. Longer gives you time to think mid-sentence.">
          <Choice id="pause" className="w-44" value={c.pause_seconds} options={PAUSES.map((p) => [p, `${p} seconds`] as [number, string])} format={(v) => `${v} seconds`} onChange={(v) => save({ pause_seconds: v })} />
        </Row>
        <Row id="timeout" title="End after silence" description="The conversation ends if you don't say anything for this long.">
          <Choice id="timeout" className="w-44" value={c.conversation_timeout_seconds} options={TIMEOUTS} format={(v) => `${v} seconds`} onChange={(v) => save({ conversation_timeout_seconds: v })} />
        </Row>
        <Row id="threshold" title="Mic sensitivity" description="If it never notices you've stopped (noisy room), lower it. If it misses a quiet voice, raise it.">
          <Choice id="threshold" className="w-56" value={c.speech_threshold} options={SENSITIVITY} onChange={(v) => save({ speech_threshold: v })} />
        </Row>
      </Section>

      <Section icon={AudioLines} tint="bg-sky-500" title="Speech recognition">
        <Row id="model" title="Model" description={<>{model?.note} {model && !model.downloaded && `Downloads ${formatSize(model.size_mb)} once.`}</>}>
          <Select value={c.whisper_model} onValueChange={(v) => save({ whisper_model: v })}>
            <SelectTrigger id="model" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              {state.models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span>{m.label}</span>
                  <span className="text-muted-foreground">{formatSize(m.size_mb)}</span>
                  {!m.downloaded && <Badge variant="outline" className="ml-1">download</Badge>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row id="language" title="Language" description="What you speak. “Detect automatically” helps with mixed languages.">
          <Choice id="language" className="w-52" value={c.language} options={LANGUAGES} onChange={(v) => save({ language: v })} />
        </Row>
      </Section>

      <Section icon={Mic} tint="bg-orange-500" title="Microphone">
        <Row id="mic" title="Input device" description="Built-in mics often sound better than Bluetooth headsets.">
          <div className="flex items-center gap-1">
            <Select value={c.input_device ?? SYSTEM_DEFAULT} onValueChange={(v) => save({ input_device: v === SYSTEM_DEFAULT ? null : v })}>
              <SelectTrigger id="mic" className="w-60"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
                {state.devices.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                {c.input_device && !state.devices.includes(c.input_device) && <SelectItem value={c.input_device}>{c.input_device} (not connected)</SelectItem>}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" aria-label="Refresh devices" onClick={() => refresh().then(() => toast("Devices refreshed", { duration: 1200 }))}>
              <RefreshCw />
            </Button>
          </div>
        </Row>
      </Section>

      <Section icon={Sparkles} tint="bg-amber-500" title="Behaviour">
        <Row id="sounds" title="Sounds" description="Soft tones when listening starts and stops.">
          <Switch id="sounds" checked={c.sounds} onCheckedChange={(v) => save({ sounds: v })} />
        </Row>
        <Row id="login" title="Start at login" description={`Launch ${c.assistant_name} in the menu bar when you log in.`}>
          <Switch
            id="login"
            checked={state.login_enabled}
            onCheckedChange={async (v) => {
              const enabled = await api.setLogin(v);
              setState((s) => (s ? { ...s, login_enabled: enabled } : s));
            }}
          />
        </Row>
      </Section>

      <Section icon={ShieldCheck} tint="bg-teal-600" title="Privacy">
        <Row id="history" title="Save history" description="Keep a searchable log of questions and answers on this Mac. Everything — speech, model and voice — runs locally.">
          <Switch id="history" checked={c.save_history} onCheckedChange={(v) => save({ save_history: v })} />
        </Row>
      </Section>

      <Section icon={Info} tint="bg-stone-500" title="About">
        <Row title={`${c.assistant_name} ${state.version}`} description={<span data-selectable>{state.data_dir}</span>}>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onRunSetup}>
              <Sparkles /> Run setup again
            </Button>
            <Button variant="outline" size="sm" onClick={() => api.openDataFolder().catch((e) => toast.error(`Couldn't open the folder: ${e}`))}>
              <FolderOpen /> Show data folder
            </Button>
          </div>
        </Row>
      </Section>
    </>
  );
}
