//! Commands invoked by the main app window (Home / Insights / History / Settings).

use crate::config::{self, Config};
use crate::{audio, history, model, permission, speech, Core};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    label: &'static str,
    size_mb: u32,
    note: &'static str,
    downloaded: bool,
}

#[derive(Serialize)]
pub struct BrainInfo {
    #[serde(flatten)]
    model: &'static model::BrainModel,
    downloaded: bool,
}

const WHISPER_MODELS: &[(&str, &str, u32, &str)] = &[
    ("large-v3-turbo-q5_0", "Large v3 Turbo", 547, "Recommended: best accuracy for its speed. Shared with Murmur."),
    ("large-v3-q5_0", "Large v3", 1080, "Slower; a little better with accents and mixed languages."),
    ("small", "Small (multilingual)", 466, "Faster; good for Hindi."),
    ("small.en", "Small (English)", 466, "Faster, English only. Fine for short questions."),
    ("base.en", "Base (English)", 142, "Very fast, less accurate."),
];

#[derive(Serialize)]
pub struct Choice {
    id: &'static str,
    label: &'static str,
}

#[derive(Serialize)]
pub struct Permissions {
    accessibility: bool,
    /// "granted" | "denied" | "not_asked" | "unknown"
    microphone: &'static str,
}

#[derive(Serialize)]
pub struct OllamaState {
    running: bool,
    models: Vec<String>,
    error: Option<String>,
}

/// The two models Jarvis needs, and their downloads in progress (0–1).
#[derive(Serialize)]
pub struct Models {
    speech_ready: bool,
    brain_ready: bool,
    brain_label: &'static str,
    brain_size_mb: u32,
    downloads: std::collections::HashMap<&'static str, f32>,
}

#[derive(Serialize)]
pub struct AppState {
    config: Config,
    status: String,
    model_loaded: bool,
    permissions: Permissions,
    ollama: OllamaState,
    setup: Models,
    voices: Vec<speech::Voice>,
    models: Vec<ModelInfo>,
    devices: Vec<String>,
    /// The built-in AI models to choose from, and the Mac's memory to choose by.
    brains: Vec<BrainInfo>,
    ram_gb: u32,
    hotkeys: Vec<Choice>,
    login_enabled: bool,
    version: &'static str,
    data_dir: String,
}

#[derive(Serialize)]
pub struct SaveResult {
    restarting: bool,
    reloading_model: bool,
}

fn hotkeys() -> Vec<Choice> {
    vec![
        Choice { id: "right_option", label: "Right Option ⌥" },
        Choice { id: "right_command", label: "Right Command ⌘" },
        Choice { id: "right_control", label: "Right Control ⌃" },
        Choice { id: "right_shift", label: "Right Shift ⇧" },
        Choice { id: "fn", label: "Fn / 🌐" },
    ]
}

#[tauri::command]
pub fn get_state(app: AppHandle, core: State<'_, Arc<Core>>) -> AppState {
    use tauri_plugin_autostart::ManagerExt;
    let dir = config::data_dir();
    let cfg = core.cfg();
    let ollama = match core.brain.ollama.models() {
        Ok(models) => OllamaState { running: true, models, error: None },
        Err(e) => OllamaState { running: false, models: vec![], error: Some(e.to_string()) },
    };
    AppState {
        status: core.status.lock().unwrap().clone(),
        model_loaded: core.transcriber.lock().unwrap().is_some(),
        permissions: Permissions { accessibility: permission::has_accessibility(false), microphone: microphone_status() },
        ollama,
        setup: Models {
            speech_ready: model::model_path(&dir, &cfg.whisper_model).exists(),
            brain_ready: model::brain_path(&dir, &cfg.builtin_model).exists(),
            brain_label: model::brain(&cfg.builtin_model).label,
            brain_size_mb: model::brain(&cfg.builtin_model).size_mb,
            downloads: core.downloads.lock().unwrap().clone(),
        },
        voices: speech::voices(),
        models: WHISPER_MODELS
            .iter()
            .map(|&(id, label, size_mb, note)| ModelInfo { id, label, size_mb, note, downloaded: model::model_path(&dir, id).exists() })
            .collect(),
        devices: audio::input_device_names(),
        brains: model::BRAINS.iter().map(|b| BrainInfo { model: b, downloaded: model::brain_path(&dir, b.id).exists() }).collect(),
        ram_gb: model::ram_gb(),
        hotkeys: hotkeys(),
        login_enabled: app.autolaunch().is_enabled().unwrap_or(false),
        version: env!("CARGO_PKG_VERSION"),
        data_dir: dir.display().to_string(),
        config: cfg,
    }
}

/// Saves and applies settings. A hotkey change restarts the app (the key tap is set up once);
/// a speech-model change loads it in the background; everything else applies immediately.
#[tauri::command]
pub fn save_config(app: AppHandle, core: State<'_, Arc<Core>>, config: Config) -> Result<SaveResult, String> {
    let old = core.cfg();
    config::save(&config).map_err(|e| e.to_string())?;
    *core.cfg.write().unwrap() = config.clone();
    core.brain.configure(&config);
    if old.voice != config.voice || old.speech_rate != config.speech_rate {
        core.speaker.configure(&config.voice, config.speech_rate);
    }
    if old.llm_model != config.llm_model || old.brain != config.brain || old.builtin_model != config.builtin_model || old.ollama_url != config.ollama_url {
        *core.last_warm_up.lock().unwrap() = None;
        core.inner().warm_up_llm();
    }
    let restarting = old.hotkey != config.hotkey;
    let reloading_model = old.whisper_model != config.whisper_model && !restarting;
    if restarting {
        mlog!("hotkey changed to {}, restarting", config.hotkey);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            app.restart();
        });
    } else if reloading_model {
        mlog!("speech model changed to {}", config.whisper_model);
        let core = core.inner().clone();
        std::thread::spawn(move || core.load_model());
    }
    Ok(SaveResult { restarting, reloading_model })
}

/// Says a sample sentence in `voice` so it can be compared before choosing it.
#[tauri::command]
pub fn preview_voice(core: State<'_, Arc<Core>>, voice: String, rate: u32) {
    let short = voice.split(" (").next().unwrap_or(&voice);
    let text = format!("Hi, I'm {short}. Your meeting is at three thirty, and it may rain this evening.");
    core.speaker.preview(&voice, rate, &text);
}

#[tauri::command]
pub fn stop_speaking(core: State<'_, Arc<Core>>) {
    core.inner().stop_all();
}

/// Asks a typed question; the answer streams back through the `reply` event and is spoken.
#[tauri::command]
pub fn ask_text(core: State<'_, Arc<Core>>, question: String) -> Result<(), String> {
    core.inner().ask_typed(question.trim()).map_err(|e| e.to_string())
}

/// Setup: download whichever models are missing (progress arrives as `download-progress`).
#[tauri::command]
pub fn download_models(core: State<'_, Arc<Core>>) {
    core.inner().download_models();
}

/// Setup: make macOS ask for microphone access.
#[tauri::command]
pub fn request_microphone() {
    request_microphone_access();
}

/// Setup is complete (or skipped): don't show it on launch again.
#[tauri::command]
pub fn finish_setup(core: State<'_, Arc<Core>>) -> Result<(), String> {
    let mut cfg = core.cfg();
    cfg.setup_done = true;
    config::save(&cfg).map_err(|e| e.to_string())?;
    *core.cfg.write().unwrap() = cfg;
    core.ready_status();
    Ok(())
}

/// The widget's Yes / No buttons while Jarvis asks before a risky action.
#[tauri::command]
pub fn confirm_answer(core: State<'_, Arc<Core>>, yes: bool) {
    if let Some(tx) = core.pending_confirm.lock().unwrap().as_ref() {
        let _ = tx.send(yes);
    }
}

#[tauri::command]
pub fn new_conversation(core: State<'_, Arc<Core>>) {
    core.new_conversation();
}

/// Newest first. `limit` defaults to 500; Insights asks for everything.
#[tauri::command]
pub fn history_list(query: String, limit: Option<usize>) -> Vec<history::Entry> {
    history::search(&query, limit.unwrap_or(500))
}

#[tauri::command]
pub fn history_delete(app: AppHandle, time: String) -> Result<(), String> {
    history::delete(&time).map_err(|e| e.to_string())?;
    let _ = app.emit_to("main", "history-updated", ());
    Ok(())
}

#[tauri::command]
pub fn history_clear(app: AppHandle) -> Result<(), String> {
    history::clear().map_err(|e| e.to_string())?;
    let _ = app.emit_to("main", "history-updated", ());
    Ok(())
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("no stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_login(app: AppHandle, enabled: bool) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let auto = app.autolaunch();
    let result = if enabled { auto.enable() } else { auto.disable() };
    if let Err(e) = result {
        mlog!("start at login: {e}");
    }
    auto.is_enabled().unwrap_or(false)
}

/// Shows the system permission prompt (if not decided yet) and opens the right Settings pane.
#[tauri::command]
pub fn open_privacy(pane: String) {
    if pane == "accessibility" {
        permission::has_accessibility(true);
    }
    let anchor = match pane.as_str() {
        "microphone" => "Privacy_Microphone",
        _ => "Privacy_Accessibility",
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    let _ = std::process::Command::new("open").arg(url).spawn();
}

/// Opens System Settings where Premium / Enhanced voices can be downloaded.
#[tauri::command]
pub fn open_voice_settings() {
    let url = "x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent";
    let _ = std::process::Command::new("open").arg(url).spawn();
}

#[tauri::command]
pub fn open_data_folder() -> Result<(), String> {
    crate::open_path(&config::data_dir())
}

fn microphone_status() -> &'static str {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use objc2_foundation::NSString;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    let Some(class) = AnyClass::get(c"AVCaptureDevice") else { return "unknown" };
    // AVMediaTypeAudio
    let media = NSString::from_str("soun");
    let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: &*media] };
    match status {
        0 => "not_asked",
        1 | 2 => "denied",
        3 => "granted",
        _ => "unknown",
    }
}

/// Asks macOS for microphone access through AVFoundation, the same API the status is read from,
/// so the app sees the answer straight away (opening the mic via Core Audio also triggers the
/// prompt, but the status only updates after a restart). Shows the system prompt the first time.
fn request_microphone_access() {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    let Some(class) = AnyClass::get(c"AVCaptureDevice") else { return };
    // AVMediaTypeAudio
    let media = NSString::from_str("soun");
    let handler = RcBlock::new(|granted: Bool| mlog!("microphone access {}", if granted.as_bool() { "granted" } else { "denied" }));
    unsafe {
        let _: () = msg_send![class, requestAccessForMediaType: &*media, completionHandler: &*handler];
    }
}
