//! Recording lifecycle: idle → countdown → recording ⇄ paused → stopping → idle.
//! While recording, the main window hides. The helper shows a native floating control bar
//! (it stays above every Space and full-screen app) whose buttons arrive as `barAction` events.
//! Capturita's own windows are excluded from the capture by the helper.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::helper::Helper;

const COUNTDOWN_SECONDS: u64 = 3;
/// The helper replies with this when the user cancels during the countdown.
const CANCELLED: &str = "Cancelled";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    #[default]
    Idle,
    Countdown,
    Recording,
    Paused,
    Stopping,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub status: Status,
    /// Unix ms when capture started.
    pub started_at: Option<i64>,
    /// Total paused time so far, in ms.
    pub paused_ms: i64,
    /// Unix ms when the current pause began.
    pub paused_at: Option<i64>,
}

#[derive(Default)]
pub struct Recording {
    status: Mutex<RecordingStatus>,
    options: Mutex<Option<Value>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn update(app: &AppHandle, change: impl FnOnce(&mut RecordingStatus)) -> RecordingStatus {
    let recording = app.state::<Recording>();
    let mut status = recording.status.lock().unwrap();
    change(&mut status);
    let snapshot = status.clone();
    drop(status);
    let _ = app.emit("recording-status", &snapshot);
    snapshot
}

fn current(app: &AppHandle) -> Status {
    app.state::<Recording>().status.lock().unwrap().status
}

pub fn recordings_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().video_dir().map_err(|e| e.to_string())?.join("Capturita");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Back to idle and bring the main window back.
fn back_to_main(app: &AppHandle) {
    *app.state::<Recording>().options.lock().unwrap() = None;
    update(app, |s| *s = RecordingStatus::default());
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Called when a recording ends, whether the user stopped it or the system did.
pub fn finish(app: &AppHandle, result: Result<Value, String>) {
    back_to_main(app);
    match result {
        Ok(project) => {
            let _ = app.emit("recording-finished", project);
        }
        Err(message) => {
            let _ = app.emit("recording-error", message);
        }
    }
}

pub fn on_helper_exit(app: &AppHandle) {
    if current(app) != Status::Idle {
        finish(app, Err("The recorder stopped unexpectedly. Please try again.".into()));
    }
}

/// Starts or stops from the global shortcut.
pub fn toggle_from_shortcut(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match current(&app) {
            // The main window owns the recording settings, so it starts the recording.
            Status::Idle => {
                let _ = app.emit_to("main", "shortcut-record", ());
            }
            Status::Countdown => cancel_countdown(&app).await,
            Status::Recording | Status::Paused => {
                let _ = stop(&app).await;
            }
            Status::Stopping => {}
        }
    });
}

/// Buttons on the helper's floating control bar.
pub fn bar_action(app: &AppHandle, action: &str) {
    let app = app.clone();
    let action = action.to_string();
    tauri::async_runtime::spawn(async move {
        let result = match action.as_str() {
            "pause" => pause(&app).await,
            "resume" => resume(&app).await,
            "stop" => stop(&app).await,
            "discard" => cancel(&app).await,
            _ => Ok(()),
        };
        if let Err(error) = result {
            eprintln!("[recording] bar action `{action}` failed: {error}");
        }
    });
}

async fn cancel_countdown(app: &AppHandle) {
    let _ = app.state::<Helper>().call(app, "cancelCountdown", Value::Null, Some(Duration::from_secs(5))).await;
}

async fn pause(app: &AppHandle) -> Result<(), String> {
    if current(app) != Status::Recording {
        return Err("Not recording".into());
    }
    app.state::<Helper>().call(app, "pause", Value::Null, Some(Duration::from_secs(10))).await?;
    update(app, |s| {
        s.status = Status::Paused;
        s.paused_at = Some(now_ms());
    });
    Ok(())
}

async fn resume(app: &AppHandle) -> Result<(), String> {
    if current(app) != Status::Paused {
        return Err("Not paused".into());
    }
    app.state::<Helper>().call(app, "resume", Value::Null, Some(Duration::from_secs(10))).await?;
    update(app, |s| {
        s.status = Status::Recording;
        if let Some(paused_at) = s.paused_at.take() {
            s.paused_ms += now_ms() - paused_at;
        }
    });
    Ok(())
}

async fn cancel(app: &AppHandle) -> Result<(), String> {
    match current(app) {
        Status::Countdown => cancel_countdown(app).await,
        Status::Recording | Status::Paused => {
            update(app, |s| s.status = Status::Stopping);
            let result = app.state::<Helper>().call(app, "cancel", Value::Null, Some(Duration::from_secs(60))).await;
            back_to_main(app);
            result?;
        }
        _ => {}
    }
    Ok(())
}

async fn stop(app: &AppHandle) -> Result<(), String> {
    if !matches!(current(app), Status::Recording | Status::Paused) {
        return Err("Not recording".into());
    }
    update(app, |s| s.status = Status::Stopping);
    let helper = app.state::<Helper>();
    // Finishing large files can take a moment.
    let result = helper.call(app, "stop", Value::Null, Some(Duration::from_secs(300))).await;
    finish(app, result);
    Ok(())
}

const PASSTHROUGH: &[&str] = &["permissions", "requestPermission", "listSources", "thumbnails", "pickArea", "showCamera", "hideCamera", "setAppearance"];

/// Forwards non-recording requests (permissions, sources, area picker, camera bubble) to the helper.
#[tauri::command]
pub async fn recorder_request(app: AppHandle, helper: State<'_, Helper>, cmd: String, args: Option<Value>) -> Result<Value, String> {
    if !PASSTHROUGH.contains(&cmd.as_str()) {
        return Err(format!("`{cmd}` cannot be called directly"));
    }
    // The area picker waits for the user, so it has no timeout.
    let timeout = (cmd != "pickArea").then(|| Duration::from_secs(30));
    helper.call(&app, &cmd, args.unwrap_or(Value::Null), timeout).await
}

#[tauri::command]
pub fn get_recording_status(recording: State<'_, Recording>) -> RecordingStatus {
    recording.status.lock().unwrap().clone()
}

/// Hides the main window and starts the recording; the helper's floating bar shows the countdown.
#[tauri::command]
pub async fn prepare_recording(app: AppHandle, helper: State<'_, Helper>, options: Value) -> Result<(), String> {
    if current(&app) != Status::Idle {
        return Err("A recording is already in progress".into());
    }
    let mut args = options;
    let name = chrono::Local::now().format("%Y-%m-%d at %H.%M.%S").to_string();
    let dir = recordings_root(&app)?.join(name);
    args["outputDir"] = json!(dir.to_string_lossy());
    args["countdown"] = json!(COUNTDOWN_SECONDS);
    *app.state::<Recording>().options.lock().unwrap() = Some(args.clone());

    update(&app, |s| s.status = Status::Countdown);
    // Launching with CAPTURITA_KEEP_WINDOW=1 keeps the window on screen while recording,
    // so Capturita can film itself (e.g. for its own demo video).
    if std::env::var_os("CAPTURITA_KEEP_WINDOW").is_none() {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
    }

    match helper.call(&app, "start", args, Some(Duration::from_secs(COUNTDOWN_SECONDS + 30))).await {
        Ok(_) => {
            update(&app, |s| {
                s.status = Status::Recording;
                s.started_at = Some(now_ms());
            });
            Ok(())
        }
        Err(error) if error == CANCELLED => {
            back_to_main(&app);
            Ok(())
        }
        Err(error) => {
            finish(&app, Err(error.clone()));
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn pause_recording(app: AppHandle) -> Result<(), String> {
    pause(&app).await
}

#[tauri::command]
pub async fn resume_recording(app: AppHandle) -> Result<(), String> {
    resume(&app).await
}

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<(), String> {
    stop(&app).await
}

/// Discards the recording (or the countdown) without saving anything.
#[tauri::command]
pub async fn cancel_recording(app: AppHandle) -> Result<(), String> {
    cancel(&app).await
}

/// Saved recordings, newest first. Each entry is a project.json plus its folder path.
#[tauri::command]
pub fn list_recordings(app: AppHandle) -> Result<Vec<Value>, String> {
    let root = recordings_root(&app)?;
    let mut projects: Vec<Value> = std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let dir = entry.path();
            let text = std::fs::read_to_string(dir.join("project.json")).ok()?;
            let mut project: Value = serde_json::from_str(&text).ok()?;
            project["path"] = json!(dir.to_string_lossy());
            Some(project)
        })
        .collect();
    projects.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    Ok(projects)
}

/// A recording's folder. Only plain folder names inside the recordings folder are accepted.
fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return Err("Invalid recording id".into());
    }
    let dir = recordings_root(app)?.join(id);
    if !dir.join("project.json").is_file() {
        return Err("Recording not found".into());
    }
    Ok(dir)
}

#[tauri::command]
pub async fn delete_recording(app: AppHandle, helper: State<'_, Helper>, id: String) -> Result<(), String> {
    // To the Trash, not erased: Delete is one click, so it has to be recoverable.
    let dir = project_dir(&app, &id)?;
    helper.call(&app, "trash", json!({ "path": dir.to_string_lossy() }), Some(Duration::from_secs(30))).await.map(|_| ())
}

/// The editor's changes (edit.json), or nothing if the recording hasn't been edited yet.
#[tauri::command]
pub fn load_edit(app: AppHandle, id: String) -> Result<Option<Value>, String> {
    let path = project_dir(&app, &id)?.join("edit.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Writes edit.json via a temporary file so a crash mid-write can't leave it half written.
#[tauri::command]
pub fn save_edit(app: AppHandle, id: String, edit: Value) -> Result<(), String> {
    let dir = project_dir(&app, &id)?;
    let temporary = dir.join(".edit.json.tmp");
    let text = serde_json::to_string_pretty(&edit).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, dir.join("edit.json")).map_err(|e| e.to_string())
}

/// Copies a song into the project folder as `music.<ext>` (replacing any earlier one) so the
/// project stays self-contained. Body: the file's bytes; headers: `id` and `name`.
/// Returns the file name inside the project.
#[tauri::command]
pub fn import_music(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).map(str::to_string);
    let id = header("id").ok_or("Missing id header")?;
    // The name is URL-encoded by the webview (headers must be ASCII); only its extension matters.
    let name = header("name").unwrap_or_default().replace("%2E", ".").replace("%2e", ".");
    let ext = std::path::Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| ["mp3", "m4a", "aac", "wav", "aif", "aiff", "caf", "flac", "ogg"].contains(&e.as_str()))
        .ok_or("Choose an audio file (MP3, M4A, AAC, WAV, AIFF, FLAC)")?;
    let dir = project_dir(&app, &id)?;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("music.") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let file = format!("music.{ext}");
    std::fs::write(dir.join(&file), bytes).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Copies an image into the project folder as `background-<time>.<ext>` (replacing any earlier
/// one) to use as the video's background. A new name each time keeps the webview from showing a
/// cached copy of the previous image.
#[tauri::command]
pub fn import_background(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).map(str::to_string);
    let id = header("id").ok_or("Missing id header")?;
    let name = header("name").unwrap_or_default().replace("%2E", ".").replace("%2e", ".");
    let ext = std::path::Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| ["png", "jpg", "jpeg", "webp", "gif", "heic"].contains(&e.as_str()))
        .ok_or("Choose an image (PNG, JPEG, WebP, HEIC)")?;
    let dir = project_dir(&app, &id)?;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("background-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let file = format!("background-{}.{ext}", chrono::Local::now().timestamp_millis());
    std::fs::write(dir.join(&file), bytes).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Makes `screen-preview.mp4`, a 1080p copy of the screen video that the editor plays smoothly
/// (exports still use the original). Returns its file name; quick if it already exists.
#[tauri::command]
pub async fn make_preview(app: AppHandle, helper: State<'_, Helper>, id: String) -> Result<String, String> {
    let dir = project_dir(&app, &id)?;
    let result = helper.call(&app, "makePreview", serde_json::json!({ "dir": dir.to_string_lossy() }), None).await?;
    result.as_str().map(str::to_string).ok_or_else(|| "Unexpected reply while making the preview".into())
}

/// Saves the library poster frame (a small JPEG made by the webview) as `thumb.jpg` in the project.
#[tauri::command]
pub fn save_thumbnail(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let id = request.headers().get("id").and_then(|v| v.to_str().ok()).ok_or("Missing id header")?;
    if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(&[0xff, 0xd8]) {
        return Err("Expected a small JPEG".into());
    }
    std::fs::write(project_dir(&app, id)?.join("thumb.jpg"), bytes).map_err(|e| e.to_string())
}

/// Appends a diagnostic line from the webview to ~/Library/Logs/com.capturita.app/webview.log.
#[tauri::command]
pub fn log_debug(app: AppHandle, message: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("webview.log"))
        .map_err(|e| e.to_string())?;
    let time = chrono::Local::now().format("%H:%M:%S%.3f");
    writeln!(file, "{time} {message}").map_err(|e| e.to_string())
}

/// macOS only applies a new screen recording permission after the app restarts.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn recordings_dir(app: AppHandle) -> Result<String, String> {
    Ok(recordings_root(&app)?.to_string_lossy().into_owned())
}
