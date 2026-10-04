// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Config {
  hotkey: string;
  whisper_model: string;
  language: string;
  input_device: string | null;
  /** "builtin" (the AI bundled with Jarvis) or "ollama". */
  brain: "builtin" | "ollama";
  /** Which built-in model: "8b" (default) or "4b" (lighter). */
  builtin_model: string;
  ollama_url: string;
  llm_model: string;
  keep_alive: string;
  system_prompt: string | null;
  assistant_name: string;
  voice: string;
  speech_rate: number;
  speak_replies: boolean;
  sounds: boolean;
  forget_after_minutes: number;
  history_turns: number;
  pause_seconds: number;
  conversation_timeout_seconds: number;
  speech_threshold: number;
  save_history: boolean;
  /** Act on the Mac: apps, websites, timers, reminders, calendar, volume, files… */
  actions: boolean;
  /** Web search, reading pages and weather. Only search words and addresses leave the Mac. */
  web_access: boolean;
  /** City for the weather when none is named; empty = guessed from the connection. */
  location: string;
  setup_done: boolean;
}

export interface BrainInfo {
  id: string;
  label: string;
  size_mb: number;
  min_ram_gb: number;
  note: string;
  downloaded: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  size_mb: number;
  note: string;
  downloaded: boolean;
}

export interface Voice {
  name: string;
  locale: string;
}

export interface AppState {
  config: Config;
  status: string;
  model_loaded: boolean;
  permissions: { accessibility: boolean; microphone: "granted" | "denied" | "not_asked" | "unknown" };
  ollama: { running: boolean; models: string[]; error: string | null };
  /** The speech and AI models, and downloads in progress (0–1) keyed "speech" / "brain". */
  setup: { speech_ready: boolean; brain_ready: boolean; brain_label: string; brain_size_mb: number; downloads: Partial<Record<"speech" | "brain", number>> };
  voices: Voice[];
  models: ModelInfo[];
  devices: string[];
  brains: BrainInfo[];
  ram_gb: number;
  hotkeys: { id: string; label: string }[];
  login_enabled: boolean;
  version: string;
  data_dir: string;
}

export interface Entry {
  time: string;
  question: string;
  answer: string;
  mode: "quick" | "conversation" | "typed" | "";
  audio_seconds: number;
  heard_ms: number;
  first_word_ms: number;
  total_ms: number;
  model: string;
  /** What was done to answer, e.g. "Opening Slack". */
  actions?: string[];
}

/** Live answer as it streams in: "thinking" (reply = what it is doing, if anything) → "speaking" (growing text) → "done". */
export interface Reply {
  state: "thinking" | "speaking" | "done";
  question: string;
  reply: string;
}

export const api = {
  state: () => invoke<AppState>("get_state"),
  saveConfig: (config: Config) =>
    invoke<{ restarting: boolean; reloading_model: boolean }>("save_config", { config }),
  previewVoice: (voice: string, rate: number) => invoke<void>("preview_voice", { voice, rate }),
  stop: () => invoke<void>("stop_speaking"),
  ask: (question: string) => invoke<void>("ask_text", { question }),
  newConversation: () => invoke<void>("new_conversation"),
  downloadModels: () => invoke<void>("download_models"),
  requestMicrophone: () => invoke<void>("request_microphone"),
  finishSetup: () => invoke<void>("finish_setup"),
  history: (query = "", limit?: number) => invoke<Entry[]>("history_list", { query, limit }),
  deleteEntry: (time: string) => invoke<void>("history_delete", { time }),
  clearHistory: () => invoke<void>("history_clear"),
  copy: (text: string) => invoke<void>("copy_text", { text }),
  setLogin: (enabled: boolean) => invoke<boolean>("set_login", { enabled }),
  openPrivacy: (pane: "accessibility" | "microphone") => invoke<void>("open_privacy", { pane }),
  openVoiceSettings: () => invoke<void>("open_voice_settings"),
  openDataFolder: () => invoke<void>("open_data_folder"),
  confirm: (yes: boolean) => invoke<void>("confirm_answer", { yes }),
};

export const events = {
  status: (cb: (s: string) => void): Promise<UnlistenFn> => listen<string>("status", (e) => cb(e.payload)),
  historyUpdated: (cb: () => void) => listen("history-updated", () => cb()),
  navigate: (cb: (tab: string) => void) => listen<string>("navigate", (e) => cb(e.payload)),
  reply: (cb: (r: Reply) => void) => listen<Reply>("reply", (e) => cb(e.payload)),
  replyError: (cb: (message: string) => void) => listen<string>("reply-error", (e) => cb(e.payload)),
  replyStopped: (cb: () => void) => listen("reply-stopped", cb),
  /** Jarvis asks before a risky action ("Move report.pdf to the Trash?"); "" once answered. */
  confirm: (cb: (question: string) => void) => listen<string>("confirm", (e) => cb(e.payload)),
  downloadProgress: (cb: (p: { model: "speech" | "brain"; progress: number | null }) => void) =>
    listen<{ model: "speech" | "brain"; progress: number | null }>("download-progress", (e) => cb(e.payload)),
  downloadError: (cb: (message: string) => void) => listen<string>("download-error", (e) => cb(e.payload)),
};

/** Time from finishing speaking to hearing the first words of the answer. */
export const responseMs = (e: Entry) => e.heard_ms + e.first_word_ms;

export const formatSeconds = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
