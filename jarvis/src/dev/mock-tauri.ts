// Browser-only stand-in for the Tauri backend, so the UI can be previewed and screenshotted
// with `pnpm ui:dev` outside the app. Never loaded inside Jarvis (see main.tsx).
import type { AppState, Config, Entry } from "@/lib/api";

const SAMPLE: [string, string][] = [
  ["What's a good way to stay focused while working?", "Try working in short, timed blocks with a five minute break after each, and keep your phone out of reach."],
  ["How many litres of water should I drink in a day?", "Most adults do well with around two to three litres a day, a bit more if it's hot or you're exercising."],
  ["Give me a quick dinner idea with paneer.", "Make a quick paneer bhurji: crumble paneer into onions, tomatoes and spices, and serve it with roti."],
  ["What's the difference between a virus and bacteria?", "Bacteria are living cells that can grow on their own, while a virus needs to get inside your cells to multiply."],
  ["Explain what an API is in simple words.", "An API is a menu that lets one program ask another for something, like a waiter taking your order to the kitchen."],
  ["Suggest a name for a cat.", "How about Mochi? It's short, cute and easy to call out."],
];

function makeHistory(): Entry[] {
  const out: Entry[] = [];
  const now = Date.now();
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const d = new Date(now - rand() * 14 * 86_400_000);
    d.setHours(9 + Math.floor(rand() * 12), Math.floor(rand() * 60));
    const [question, answer] = SAMPLE[Math.floor(rand() * SAMPLE.length)];
    const mode = (["quick", "quick", "conversation", "typed"] as const)[Math.floor(rand() * 4)];
    const audio = mode === "typed" ? 0 : 2 + rand() * 6;
    out.push({
      time: d.toISOString(), question, answer, mode, audio_seconds: audio,
      heard_ms: mode === "typed" ? 0 : Math.round(780 + rand() * 120),
      first_word_ms: Math.round(220 + rand() * 200), total_ms: Math.round(900 + rand() * 900), model: "qwen3:8b",
    });
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

let history = makeHistory();
// Preview setup: `?setup=<step>` opens it at that step; `&fresh` shows nothing done yet; `&dl=0.4` a download in progress.
const params = new URLSearchParams(location.search);
const previewSetup = params.has("setup");
const fresh = params.has("fresh");
const dl = params.has("dl") ? Number(params.get("dl")) : null;
if (previewSetup) {
  try {
    localStorage.setItem("jarvis.setupStep", params.get("setup") || "0");
  } catch {
    /* ignore */
  }
}
let config: Config = {
  hotkey: "right_option", whisper_model: "large-v3-turbo-q5_0", language: "en", input_device: null,
  brain: "builtin", builtin_model: "8b", ollama_url: "http://localhost:11434", llm_model: "qwen3:8b", keep_alive: "30m", system_prompt: null,
  assistant_name: "Jarvis", voice: "Tara", speech_rate: 195, speak_replies: true, sounds: true,
  forget_after_minutes: 5, history_turns: 8, pause_seconds: 2, conversation_timeout_seconds: 20,
  speech_threshold: 0.012, save_history: true, actions: true, web_access: true, location: "", setup_done: !previewSetup,
};

const state = (): AppState => ({
  config, status: "Ready — hold Right ⌥ to ask", model_loaded: true,
  permissions: { accessibility: !fresh, microphone: fresh ? "not_asked" : "granted" },
  ollama: { running: true, models: ["ministral-3:8b", "qwen2.5:7b", "qwen3:8b"], error: null },
  setup: {
    speech_ready: !fresh || (dl !== null && dl >= 0.99), brain_ready: !fresh, brain_label: "Qwen3 8B", brain_size_mb: 4795,
    downloads: dl !== null ? { speech: Math.min(1, dl * 2.5), brain: dl } : {},
  },
  voices: [
    { name: "Daniel", locale: "en_GB" }, { name: "Samantha", locale: "en_US" }, { name: "Aman", locale: "en_IN" },
    { name: "Rishi", locale: "en_IN" }, { name: "Tara", locale: "en_IN" }, { name: "Lekha", locale: "hi_IN" },
    { name: "Karen", locale: "en_AU" }, { name: "Moira", locale: "en_IE" },
  ],
  models: [
    { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo", size_mb: 547, note: "Recommended: best accuracy for its speed. Shared with Murmur.", downloaded: true },
    { id: "small.en", label: "Small (English)", size_mb: 466, note: "Faster, English only.", downloaded: false },
  ],
  devices: ["MacBook Pro Microphone", "AirPods Pro"],
  brains: [
    { id: "8b", label: "Qwen3 8B", size_mb: 4795, min_ram_gb: 16, note: "The built-in AI. Accurate with multi-step tasks like clicking through pages and apps.", downloaded: true },
    { id: "4b", label: "Qwen3 4B", size_mb: 2382, min_ram_gb: 8, note: "Lighter and quicker, for Macs with less than 16 GB of memory. Weaker at multi-step tasks.", downloaded: false },
  ],
  ram_gb: 16,
  hotkeys: [{ id: "right_option", label: "Right Option ⌥" }, { id: "right_command", label: "Right Command ⌘" }],
  login_enabled: true, version: "0.1.0", data_dir: "~/Library/Application Support/Jarvis",
});

const handlers: Record<string, (a: any) => unknown> = {
  get_state: state,
  save_config: (a) => ((config = a.config), { restarting: false, reloading_model: false }),
  history_list: (a) =>
    history
      .filter((e) => !a.query || `${e.question} ${e.answer}`.toLowerCase().includes(a.query.toLowerCase()))
      .slice(0, a.limit ?? 500),
  history_delete: (a) => void (history = history.filter((e) => e.time !== a.time)),
  history_clear: () => void (history = []),
  set_login: (a) => a.enabled,
  finish_setup: () => void (config = { ...config, setup_done: true }),
  "plugin:event|listen": () => Math.floor(Math.random() * 1e6),
  "plugin:event|unlisten": () => null,
};

let cbId = 0;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => ++cbId,
  invoke: async (cmd: string, args: any) => {
    const h = handlers[cmd];
    if (!h) return null;
    return h(args ?? {});
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
