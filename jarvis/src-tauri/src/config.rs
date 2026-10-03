use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// User settings, stored as editable JSON in the app data dir.
/// Edit the file, then choose "Reload Settings" from the menu bar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Hold-to-talk key: "right_option", "right_command", "right_control", "right_shift", "fn".
    /// Pick one Murmur isn't using (Murmur defaults to "fn").
    pub hotkey: String,
    /// Whisper model id, e.g. "large-v3-turbo-q5_0", "small.en". Shared with Murmur if it has it.
    pub whisper_model: String,
    /// Spoken language code ("en", "hi", ...) or "auto".
    pub language: String,
    /// Microphone name; `None` follows the system default input.
    pub input_device: Option<String>,
    /// Where Ollama is listening.
    pub ollama_url: String,
    /// Any model from `ollama list`, e.g. "qwen3:8b", "qwen2.5:7b".
    pub llm_model: String,
    /// How long Ollama keeps the model in memory after a question ("30m", "1h", "-1" = forever).
    pub keep_alive: String,
    /// Replaces the built-in personality / instructions when set.
    pub system_prompt: Option<String>,
    /// What the assistant calls itself.
    pub assistant_name: String,
    /// macOS voice name (`say -v '?'` lists them). Premium/Enhanced voices sound best:
    /// System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.
    pub voice: String,
    /// Speaking rate in words per minute.
    pub speech_rate: u32,
    /// Speak answers aloud. Off = answers only appear in the widget.
    pub speak_replies: bool,
    /// Soft start/stop sounds.
    pub sounds: bool,
    /// Start a fresh conversation after this many minutes without a question.
    pub forget_after_minutes: u32,
    /// How many recent question/answer pairs are sent back to the model as context.
    pub history_turns: usize,
    /// Conversation mode (tap the key): this much silence after you speak sends the question.
    pub pause_seconds: f32,
    /// Conversation mode ends after this long without hearing you.
    pub conversation_timeout_seconds: u32,
    /// Mic level (RMS) that counts as speech. Raise it in a noisy room, lower it for a quiet voice.
    pub speech_threshold: f32,
    /// Keep a local log of questions and answers (History page).
    pub save_history: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: "right_option".into(),
            whisper_model: "large-v3-turbo-q5_0".into(),
            language: "en".into(),
            input_device: None,
            ollama_url: "http://localhost:11434".into(),
            llm_model: "qwen3:8b".into(),
            keep_alive: "30m".into(),
            system_prompt: None,
            assistant_name: "Jarvis".into(),
            voice: "Daniel".into(),
            speech_rate: 195,
            speak_replies: true,
            sounds: true,
            forget_after_minutes: 5,
            history_turns: 8,
            pause_seconds: 1.2,
            conversation_timeout_seconds: 20,
            speech_threshold: 0.012,
            save_history: true,
        }
    }
}

/// Root folder for config and logs: `~/Library/Application Support/Jarvis`.
pub fn data_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("Jarvis");
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
    .clone()
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn log_path() -> PathBuf {
    data_dir().join("jarvis.log")
}

pub fn save(cfg: &Config) -> anyhow::Result<()> {
    std::fs::write(config_path(), serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

/// Load the config, writing defaults on first run so the file is easy to find and edit.
/// New settings added in later versions are written back so they show up in the file.
pub fn load() -> Config {
    let path = config_path();
    let existing = std::fs::read_to_string(&path).ok();
    let cfg = match &existing {
        Some(s) => match serde_json::from_str(s) {
            Ok(cfg) => cfg,
            Err(e) => {
                // Leave a broken file alone so the user's edits aren't lost.
                mlog!("invalid config.json ({e}), using defaults");
                return Config::default();
            }
        },
        None => Config::default(),
    };
    if let Ok(s) = serde_json::to_string_pretty(&cfg) {
        if existing.as_deref() != Some(s.as_str()) {
            let _ = std::fs::write(&path, s);
        }
    }
    cfg
}

pub fn log(msg: &str) {
    use std::io::Write;
    eprintln!("[jarvis] {msg}");
    let path = log_path();
    // Keep the log small: start over once it passes 1 MB.
    if std::fs::metadata(&path).map(|m| m.len() > 1 << 20).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%H:%M:%S%.3f"));
    }
}
