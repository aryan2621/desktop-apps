//! AI editing: a language model on this Mac turns a request like "cut the part about pricing"
//! into edits. It runs with llama.cpp's server, bundled with Capturita and started in the
//! background on a local port only while it's needed. Models download once; Settings picks one.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Model {
    id: &'static str,
    name: &'static str,
    file: &'static str,
    url: &'static str,
    size_mb: u32,
    min_ram_gb: u64,
    note: &'static str,
}

/// Models that follow the edit format reliably, 4-bit GGUFs. The first is the default.
const MODELS: [Model; 2] = [
    Model {
        id: "qwen3-4b",
        name: "Qwen3 4B",
        file: "qwen3-4b-instruct-2507-q4_k_m.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        size_mb: 2382,
        min_ram_gb: 8,
        note: "Quick, and good at most edits. Runs on any Apple silicon Mac.",
    },
    Model {
        id: "gemma-4-12b",
        name: "Gemma 4 12B",
        file: "gemma-4-12b-it-qat-ud-q4_k_xl.gguf",
        url: "https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
        size_mb: 6405,
        min_ram_gb: 16,
        note: "Follows longer, more detailed requests more closely. Slower.",
    },
];
const SETTINGS_FILE: &str = "ai-settings.json";
/// Room for the transcript of a long recording (~30 minutes of speech).
const CONTEXT_TOKENS: u32 = 16384;
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// The model holds ~3 GB of memory; give it back after this long without a request.
const IDLE_STOP: Duration = Duration::from_secs(10 * 60);

struct Running {
    child: Child,
    port: u16,
    model: &'static str,
}

#[derive(Default)]
pub struct Ai {
    running: Mutex<Option<Running>>,
    last_used: Mutex<Option<Instant>>,
    downloading: Mutex<Option<&'static str>>,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: &'static str,
    name: &'static str,
    downloaded: bool,
    size_mb: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: &'static str,
    name: &'static str,
    note: &'static str,
    size_mb: u32,
    min_ram_gb: u64,
    downloaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Models {
    models: Vec<ModelInfo>,
    active: &'static str,
    /// The model downloading right now, if any.
    downloading: Option<&'static str>,
    ram_gb: u64,
}

/// One request to the model: instructions, the recording's details, and the JSON shape to answer in.
#[derive(Deserialize)]
pub struct EditRequest {
    system: String,
    user: String,
    schema: Value,
}

fn model(id: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|m| m.id == id).ok_or_else(|| format!("Unknown AI model: {id}"))
}

fn model_path(app: &AppHandle, model: &Model) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(model.file))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

/// The model chosen in Settings (the default until one is chosen).
fn active_model(app: &AppHandle) -> &'static Model {
    let chosen = settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v["model"].as_str().map(str::to_string));
    chosen.and_then(|id| model(&id).ok()).unwrap_or(&MODELS[0])
}

/// The Mac's memory in GB.
fn ram_gb() -> u64 {
    extern "C" {
        fn sysctlbyname(name: *const std::ffi::c_char, old: *mut std::ffi::c_void, oldlen: *mut usize, new: *const std::ffi::c_void, newlen: usize) -> i32;
    }
    let mut bytes: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let ok = unsafe { sysctlbyname(c"hw.memsize".as_ptr(), &mut bytes as *mut u64 as *mut _, &mut len, std::ptr::null(), 0) } == 0;
    if ok {
        bytes / (1 << 30)
    } else {
        8
    }
}

fn progress(app: &AppHandle, value: f32) {
    let _ = app.emit("ai-progress", value);
}

impl Ai {
    /// Port of a running server, if it's still alive.
    fn alive_port(&self) -> Option<u16> {
        let mut running = self.running.lock().unwrap();
        let r = running.as_mut()?;
        match r.child.try_wait() {
            Ok(None) => Some(r.port),
            _ => {
                *running = None;
                None
            }
        }
    }

    pub fn stop(&self) {
        if let Some(mut r) = self.running.lock().unwrap().take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }

    /// Stops the server once it has been idle for a while (called periodically).
    pub fn stop_if_idle(&self) {
        let idle = self.last_used.lock().unwrap().is_some_and(|t| t.elapsed() >= IDLE_STOP);
        if idle && self.alive_port().is_some() {
            self.stop();
        }
    }

    /// Starts the bundled server with the model and waits until it's ready.
    async fn ensure_server(&self, app: &AppHandle) -> Result<u16, String> {
        *self.last_used.lock().unwrap() = Some(Instant::now());
        let active = active_model(app);
        if let Some(port) = self.alive_port() {
            if self.running.lock().unwrap().as_ref().is_some_and(|r| r.model == active.id) {
                return Ok(port);
            }
            // A different model was chosen in Settings since this one started.
            self.stop();
        }
        let model = model_path(app, active)?;
        if !model.exists() {
            return Err(format!("{} isn't downloaded yet. Download it in Settings → AI editing.", active.name));
        }
        // Sidecars sit next to Capturita's own executable.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let server = exe.parent().ok_or("No app folder")?.join("llama-server");
        if !server.exists() {
            return Err("AI editing is missing from this copy of Capturita".into());
        }
        let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
        let log_path = app.path().app_log_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&log_path).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(log_path.join("llama-server.log")).map_err(|e| e.to_string())?;
        let child = Command::new(server)
            .args(["--model", &model.to_string_lossy()])
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["--ctx-size", &CONTEXT_TOKENS.to_string(), "--n-gpu-layers", "999", "--parallel", "1", "--jinja"])
            // Edits should come straight away, not after the model thinks out loud.
            .args(["--reasoning-budget", "0"])
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .spawn()
            .map_err(|e| format!("Could not start the AI: {e}"))?;
        *self.running.lock().unwrap() = Some(Running { child, port, model: active.id });

        let started = Instant::now();
        while started.elapsed() < START_TIMEOUT {
            if self.alive_port().is_none() {
                return Err("The AI stopped while starting".into());
            }
            let health = reqwest::get(format!("http://127.0.0.1:{port}/health")).await;
            if health.is_ok_and(|r| r.status().is_success()) {
                return Ok(port);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        self.stop();
        Err("The AI took too long to start".into())
    }
}

/// The model AI editing uses now.
#[tauri::command]
pub fn ai_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    let m = active_model(&app);
    Ok(ModelStatus { id: m.id, name: m.name, downloaded: model_path(&app, m)?.exists(), size_mb: m.size_mb })
}

/// Every model, for Settings.
#[tauri::command]
pub fn ai_models(app: AppHandle, ai: State<'_, Ai>) -> Result<Models, String> {
    let models = MODELS
        .iter()
        .map(|m| Ok(ModelInfo { id: m.id, name: m.name, note: m.note, size_mb: m.size_mb, min_ram_gb: m.min_ram_gb, downloaded: model_path(&app, m)?.exists() }))
        .collect::<Result<_, String>>()?;
    Ok(Models { models, active: active_model(&app).id, downloading: *ai.downloading.lock().unwrap(), ram_gb: ram_gb() })
}

/// Chooses the model AI editing uses. A running model is stopped, so the next request uses the new one.
#[tauri::command]
pub fn set_ai_model(app: AppHandle, ai: State<'_, Ai>, id: String) -> Result<(), String> {
    let m = model(&id)?;
    std::fs::write(settings_path(&app)?, json!({ "model": m.id }).to_string()).map_err(|e| e.to_string())?;
    if ai.running.lock().unwrap().as_ref().is_some_and(|r| r.model != m.id) {
        ai.stop();
    }
    Ok(())
}

/// Deletes a downloaded model to free disk space.
#[tauri::command]
pub fn delete_ai_model(app: AppHandle, ai: State<'_, Ai>, id: String) -> Result<(), String> {
    let m = model(&id)?;
    if *ai.downloading.lock().unwrap() == Some(m.id) {
        return Err("Cancel the download first.".into());
    }
    if ai.running.lock().unwrap().as_ref().is_some_and(|r| r.model == m.id) {
        ai.stop();
    }
    match std::fs::remove_file(model_path(&app, m)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Downloads a model once (the chosen one if no `id`), with `ai-progress` events (0–1).
/// Cancel with `cancel_ai_download`.
#[tauri::command]
pub async fn download_ai_model(app: AppHandle, ai: State<'_, Ai>, id: Option<String>) -> Result<(), String> {
    let m = match id {
        Some(id) => model(&id)?,
        None => active_model(&app),
    };
    let path = model_path(&app, m)?;
    if path.exists() {
        return Ok(());
    }
    {
        let mut downloading = ai.downloading.lock().unwrap();
        if downloading.is_some() {
            return Err("Another AI model is already downloading".into());
        }
        *downloading = Some(m.id);
    }
    ai.cancel.store(false, Ordering::SeqCst);
    let result = async {
        let part = path.with_extension("part");
        let mut response = reqwest::get(m.url).await.map_err(|e| format!("Could not download the AI model: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Could not download the AI model ({})", response.status()));
        }
        let total = response.content_length().unwrap_or(0);
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let (mut done, mut reported) = (0u64, 0u64);
        progress(&app, 0.0);
        while let Some(chunk) = response.chunk().await.map_err(|e| format!("The AI model download failed: {e}"))? {
            if ai.cancel.load(Ordering::SeqCst) {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err("Cancelled".into());
            }
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            if done - reported >= 4 << 20 && total > 0 {
                reported = done;
                progress(&app, done as f32 / total as f32);
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        if total > 0 && done != total {
            let _ = std::fs::remove_file(&part);
            return Err("The AI model download was incomplete. Please try again.".into());
        }
        std::fs::rename(&part, &path).map_err(|e| e.to_string())
    }
    .await;
    *ai.downloading.lock().unwrap() = None;
    result
}

#[tauri::command]
pub fn cancel_ai_download(ai: State<'_, Ai>) {
    ai.cancel.store(true, Ordering::SeqCst);
}

/// Asks the model for edits. Its answer is forced into `schema` (llama.cpp turns the JSON schema
/// into a grammar), so it's always valid JSON in the expected shape.
#[tauri::command]
pub async fn ai_edit(app: AppHandle, ai: State<'_, Ai>, request: EditRequest) -> Result<Value, String> {
    let port = ai.ensure_server(&app).await?;
    let body = json!({
        "messages": [
            { "role": "system", "content": request.system },
            { "role": "user", "content": request.user },
        ],
        // Low temperature: edits should follow the request, not be creative.
        "temperature": 0.2,
        "max_tokens": 1500,
        "response_format": { "type": "json_schema", "json_schema": { "name": "edits", "schema": request.schema } },
    });
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("The AI didn't answer: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("The AI failed ({status}): {}", response.text().await.unwrap_or_default()));
    }
    let reply: Value = response.json().await.map_err(|e| e.to_string())?;
    *ai.last_used.lock().unwrap() = Some(Instant::now());
    let content = reply["choices"][0]["message"]["content"].as_str().ok_or("The AI gave an empty answer")?;
    serde_json::from_str(content).map_err(|e| format!("The AI's answer couldn't be read: {e}"))
}
