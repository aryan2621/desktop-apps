//! AI editing: a small language model (Qwen3 4B Instruct) turns a request like "cut the part
//! about pricing" into edits. It runs on this Mac with llama.cpp's server, bundled with Capturita
//! and started in the background on a local port only while it's needed. The model downloads once.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const MODEL_FILE: &str = "qwen3-4b-instruct-2507-q4_k_m.gguf";
const MODEL_URL: &str = "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
const MODEL_SIZE_MB: u32 = 2382;
/// Room for the transcript of a long recording (~30 minutes of speech).
const CONTEXT_TOKENS: u32 = 16384;
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// The model holds ~3 GB of memory; give it back after this long without a request.
const IDLE_STOP: Duration = Duration::from_secs(10 * 60);

struct Running {
    child: Child,
    port: u16,
}

#[derive(Default)]
pub struct Ai {
    running: Mutex<Option<Running>>,
    last_used: Mutex<Option<Instant>>,
    downloading: AtomicBool,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    downloaded: bool,
    size_mb: u32,
}

/// One request to the model: instructions, the recording's details, and the JSON shape to answer in.
#[derive(Deserialize)]
pub struct EditRequest {
    system: String,
    user: String,
    schema: Value,
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(MODEL_FILE))
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
        if let Some(port) = self.alive_port() {
            return Ok(port);
        }
        let model = model_path(app)?;
        if !model.exists() {
            return Err("The AI model isn't downloaded yet".into());
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
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .spawn()
            .map_err(|e| format!("Could not start the AI: {e}"))?;
        *self.running.lock().unwrap() = Some(Running { child, port });

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

#[tauri::command]
pub fn ai_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    Ok(ModelStatus { downloaded: model_path(&app)?.exists(), size_mb: MODEL_SIZE_MB })
}

/// Downloads the AI model once, with `ai-progress` events (0–1). Cancel with `cancel_ai_download`.
#[tauri::command]
pub async fn download_ai_model(app: AppHandle, ai: State<'_, Ai>) -> Result<(), String> {
    let path = model_path(&app)?;
    if path.exists() {
        return Ok(());
    }
    if ai.downloading.swap(true, Ordering::SeqCst) {
        return Err("The AI model is already downloading".into());
    }
    ai.cancel.store(false, Ordering::SeqCst);
    let result = async {
        let part = path.with_extension("part");
        let mut response = reqwest::get(MODEL_URL).await.map_err(|e| format!("Could not download the AI model: {e}"))?;
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
    ai.downloading.store(false, Ordering::SeqCst);
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
