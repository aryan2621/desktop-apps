use crate::store;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tauri::Emitter;
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
    sync::Mutex,
};

pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    repo: &'static str,
    file: &'static str,
    size_mb: u64,
    /// Least memory (GB) the Mac should have to run it comfortably next to other apps.
    min_ram_gb: u64,
    note: &'static str,
}
/// Open models the bundled llama.cpp runs with native tool calling, 4-bit, from Unsloth's GGUFs.
pub const CATALOG: [Model; 5] = [
    Model {
        id: "qwen3.5-4b",
        name: "Qwen3.5 4B",
        repo: "unsloth/Qwen3.5-4B-GGUF",
        file: "Qwen3.5-4B-Q4_K_M.gguf",
        size_mb: 2740,
        min_ram_gb: 8,
        note: "Small and quick. Handles simple, single tool calls on any Mac.",
    },
    Model {
        id: "qwen3.5-9b",
        name: "Qwen3.5 9B",
        repo: "unsloth/Qwen3.5-9B-GGUF",
        file: "Qwen3.5-9B-Q4_K_M.gguf",
        size_mb: 5680,
        min_ram_gb: 16,
        note: "The best balance of speed and accuracy for multi-step tool use.",
    },
    Model {
        id: "gemma-4-12b",
        name: "Gemma 4 12B",
        repo: "unsloth/gemma-4-12B-it-qat-GGUF",
        file: "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
        size_mb: 6720,
        min_ram_gb: 16,
        note: "Google's model. Useful to check your tools work beyond one model family.",
    },
    Model {
        id: "gemma-4-26b-a4b",
        name: "Gemma 4 26B A4B",
        repo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF",
        file: "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf",
        size_mb: 14250,
        min_ram_gb: 32,
        note: "Large but fast: only 4B of its parameters work on each word.",
    },
    Model {
        id: "qwen3.8-27b",
        name: "Qwen3.8 27B",
        repo: "unsloth/Qwen3.8-27B-GGUF",
        file: "Qwen3.8-27B-UD-Q4_K_M.gguf",
        size_mb: 16460,
        min_ram_gb: 32,
        note: "The most capable model here, close to cloud models at tool use. Slower.",
    },
];
fn model(id: &str) -> Result<&'static Model, String> {
    CATALOG
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| "Unknown model".into())
}
/// The computer's memory in GB.
#[cfg(target_os = "macos")]
pub fn ram_gb() -> u64 {
    let mut bytes: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    extern "C" {
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            old: *mut std::ffi::c_void,
            oldlen: *mut usize,
            new: *const std::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }
    let ok = unsafe {
        sysctlbyname(
            c"hw.memsize".as_ptr(),
            &mut bytes as *mut u64 as *mut _,
            &mut len,
            std::ptr::null(),
            0,
        )
    } == 0;
    if ok {
        bytes / (1 << 30)
    } else {
        8
    }
}
/// The computer's memory in GB.
#[cfg(windows)]
pub fn ram_gb() -> u64 {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status: MemoryStatusEx = unsafe { std::mem::zeroed() };
    status.length = std::mem::size_of::<MemoryStatusEx>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
        status.total_phys / (1 << 30)
    } else {
        8
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn ram_gb() -> u64 {
    8
}

/// The strongest model this Mac runs comfortably.
pub fn recommended(ram: u64) -> &'static str {
    ["qwen3.8-27b", "qwen3.5-9b"]
        .into_iter()
        .find(|id| model(id).is_ok_and(|m| m.min_ram_gb <= ram))
        .unwrap_or("qwen3.5-4b")
}
pub fn path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    model(id)?;
    Ok(store::data_dir(app)?
        .join("models")
        .join(format!("{id}.gguf")))
}
#[derive(Default)]
pub struct Runtime {
    pub process: Mutex<Option<(String, u16, Child, String)>>,
    pub downloading: Mutex<Option<String>>,
    pub cancel: std::sync::atomic::AtomicBool,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some((_, _, child, _)) = self.process.get_mut().as_mut() {
            drop(child.stdin.take());
        }
    }
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn signal(sig: i32, handler: usize) -> usize;
}
#[cfg(unix)]
const SIGHUP: i32 = 1;
#[cfg(unix)]
const SIGINT: i32 = 2;
#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIG_IGN: usize = 1;

/// Runs as its own small process (Relay's binary with `--llama-watchdog`) that owns the model
/// server. Relay holds the other end of its stdin, which macOS closes however Relay exits, even
/// on force quit or a crash; then the model server is stopped too, so it never runs on alone.
/// Relay stops a model the same way: by closing that stdin.
pub fn watchdog(pid_file: &str, exe: &str, args: &[String]) -> ! {
    let mut child = match std::process::Command::new(exe).args(args).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Cannot start bundled runtime: {e}");
            std::process::exit(1)
        }
    };
    let _ = std::fs::write(pid_file, child.id().to_string());
    // Only Relay closing the pipe stops the model: ignore the signals sent to the whole group
    // (Ctrl-C in a terminal) or by `pkill relay`, which would otherwise leave it running.
    // Set after spawning so the model server keeps the default handlers.
    #[cfg(unix)]
    unsafe {
        for sig in [SIGHUP, SIGINT, SIGTERM] {
            signal(sig, SIG_IGN);
        }
    }
    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let closed = closed.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 64];
            while matches!(std::io::stdin().read(&mut buf), Ok(1..)) {}
            closed.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    }
    let code = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break status.code().unwrap_or(1);
        }
        if closed.load(std::sync::atomic::Ordering::SeqCst) {
            // Ask politely, then insist: the process is still ours to reap, so the pid is too.
            #[cfg(unix)]
            unsafe {
                kill(child.id() as i32, SIGTERM)
            };
            for _ in 0..30 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
            break 0;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let _ = std::fs::remove_file(pid_file);
    std::process::exit(code)
}

fn pid_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(store::data_dir(app)?.join("llama-server.pid"))
}

/// Stops a model server an earlier run left behind, in case its watchdog was killed with it.
pub fn stop_leftover(app: &tauri::AppHandle) {
    let Ok(file) = pid_file(app) else { return };
    let Some(pid) = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok())
    else {
        return;
    };
    let _ = std::fs::remove_file(&file);
    #[cfg(unix)]
    stop_if_ours(pid);
}

/// Kills `pid`, but only if it is still our model server, not an unrelated process that reused it.
#[cfg(unix)]
fn stop_if_ours(pid: i32) {
    // Only if that pid is still our model server, not an unrelated process that reused it.
    let command = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    if command.contains("llama-server") && command.contains("com.relay.mcp-workbench") {
        unsafe { kill(pid, SIGKILL) };
    }
}

/// Stops the model server by closing its watchdog's stdin, and waits for both to exit.
pub async fn stop(child: &mut Child) {
    drop(child.stdin.take());
    if tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}
pub fn catalog(app: &tauri::AppHandle) -> Result<Value, String> {
    let ram = ram_gb();
    let models: Vec<Value> = CATALOG
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "note": m.note,
                "sizeMb": m.size_mb,
                "minRamGb": m.min_ram_gb,
                "repo": m.repo,
                "installed": path(app, m.id).map(|p| p.exists()).unwrap_or(false),
            })
        })
        .collect();
    Ok(json!({"ramGb": ram, "recommended": recommended(ram), "models": models}))
}
pub async fn download(app: &tauri::AppHandle, runtime: &Runtime, id: &str) -> Result<(), String> {
    let model = model(id)?;
    let path = path(app, id)?;
    if path.exists() {
        return Ok(());
    }
    {
        let mut active = runtime.downloading.lock().await;
        if active.is_some() {
            return Err("Another model is downloading.".into());
        }
        *active = Some(id.into());
    }
    runtime
        .cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let result: Result<(), String> = async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        // Resolve a revision and LFS digest before downloading; never trust a partial file.
        let metadata: Value = client
            .get(format!(
                "https://huggingface.co/api/models/{}/revision/main?blobs=true",
                model.repo
            ))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let revision = metadata["sha"].as_str().ok_or("Model revision missing")?;
        let file = metadata["siblings"]
            .as_array()
            .and_then(|a| a.iter().find(|v| v["rfilename"] == model.file))
            .ok_or("Model file missing")?;
        let digest = file["lfs"]["sha256"]
            .as_str()
            .ok_or("Model checksum missing")?;
        let expected_size = file["size"]
            .as_u64()
            .or_else(|| file["lfs"]["size"].as_u64())
            .ok_or("Model size missing")?;
        let response = client
            .get(format!(
                "https://huggingface.co/{}/resolve/{}/{}",
                model.repo, revision, model.file
            ))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .map_err(|e| e.to_string())?;
        let part = path.with_extension("part");
        let mut output = tokio::fs::File::create(&part)
            .await
            .map_err(|e| e.to_string())?;
        let mut stream = response.bytes_stream();
        let mut done = 0u64;
        let mut sha = Sha256::new();
        let mut last = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            if runtime.cancel.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Download cancelled. You can restart it from Models.".into());
            }
            let chunk = chunk.map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            sha.update(&chunk);
            output.write_all(&chunk).await.map_err(|e| e.to_string())?;
            if last.elapsed() > Duration::from_millis(200) {
                let _ = app.emit(
                    "model-progress",
                    json!({"id":id,"done":done,"total":expected_size}),
                );
                last = std::time::Instant::now();
            }
        }
        output.flush().await.map_err(|e| e.to_string())?;
        output.sync_all().await.map_err(|e| e.to_string())?;
        drop(output);
        if done != expected_size || format!("{:x}", sha.finalize()) != digest {
            return Err("Model integrity check failed. Please retry.".into());
        }
        tokio::fs::rename(part, &path)
            .await
            .map_err(|e| e.to_string())?;
        let _ = app.emit("model-progress", json!({"id":id,"done":done,"total":done}));
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(path.with_extension("part")).await;
    }
    *runtime.downloading.lock().await = None;
    result
}
pub async fn start(
    app: &tauri::AppHandle,
    runtime: &Runtime,
    id: &str,
) -> Result<(String, String), String> {
    let path = path(app, id)?;
    if !path.exists() {
        return Err("Download this model in Models first.".into());
    }
    let mut running = runtime.process.lock().await;
    if let Some((current, port, child, token)) = running.as_mut() {
        if current == id && child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok((format!("http://127.0.0.1:{port}"), token.clone()));
        }
        stop(child).await;
    }
    *running = None;
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| e.to_string())?
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let bundled = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("No executable directory")?
        .join("llama-server");
    let exe = if bundled.exists() {
        bundled
    } else {
        #[cfg(target_os = "macos")]
        {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/llama-server-aarch64-apple-darwin")
        }
        // The on-device model server is only built for macOS so far.
        #[cfg(not(target_os = "macos"))]
        return Err("On-device models run on macOS only for now. Add a Claude, OpenAI or Gemini key in Settings to use Relay's AI.".into());
    };
    let token = uuid::Uuid::new_v4().to_string();
    let log = std::fs::File::create(store::data_dir(app)?.join("inference.log"))
        .map_err(|e| e.to_string())?;
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .arg("--llama-watchdog")
        .arg(pid_file(app)?)
        .arg(exe)
        .args([
            "--model",
            path.to_str().ok_or("Invalid model path")?,
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--api-key",
            &token,
            "--ctx-size",
            "16384",
            "--n-gpu-layers",
            "999",
            "--parallel",
            "1",
            "--jinja",
            "--reasoning-budget",
            "0",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("Cannot start bundled runtime: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    for _ in 0..120 {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            // Say why, from the runtime's own log, instead of pointing at a file.
            let log = std::fs::read_to_string(store::data_dir(app)?.join("inference.log"))
                .unwrap_or_default();
            let reason = log
                .lines()
                .rev()
                .find(|l| l.to_lowercase().contains("error") || l.contains("failed"))
                .unwrap_or("it stopped without an error message")
                .trim()
                .to_string();
            return Err(format!("The model could not start: {reason}"));
        }
        if client
            .get(format!("http://127.0.0.1:{port}/health"))
            .bearer_auth(&token)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            *running = Some((id.into(), port, child, token.clone()));
            return Ok((format!("http://127.0.0.1:{port}"), token.clone()));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    stop(&mut child).await;
    Err("The model took too long to load. Try again, or pick a smaller model.".into())
}

#[tauri::command]
pub async fn model_catalog(app: tauri::AppHandle) -> Result<Value, String> {
    catalog(&app)
}
/// Loads the model ahead of the first message so the first reply doesn't wait for it.
#[tauri::command]
pub async fn warm_model(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Runtime>,
    id: String,
) -> Result<(), String> {
    start(&app, &runtime, &id).await.map(|_| ())
}
#[tauri::command]
pub async fn download_model(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Runtime>,
    id: String,
) -> Result<(), String> {
    download(&app, &runtime, &id).await
}
#[tauri::command]
pub fn cancel_download(runtime: tauri::State<'_, Runtime>) {
    runtime
        .cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
}
#[tauri::command]
pub async fn stop_model(runtime: tauri::State<'_, Runtime>) -> Result<(), String> {
    if let Some((_, _, mut child, _)) = runtime.process.lock().await.take() {
        stop(&mut child).await;
    }
    Ok(())
}
#[tauri::command]
pub async fn delete_model(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Runtime>,
    id: String,
) -> Result<(), String> {
    if runtime.downloading.lock().await.as_deref() == Some(&id) {
        return Err("Cancel the download first.".into());
    }
    {
        let mut running = runtime.process.lock().await;
        if running.as_ref().is_some_and(|p| p.0 == id) {
            if let Some((_, _, mut child, _)) = running.take() {
                stop(&mut child).await;
            }
        }
    }
    let p = path(&app, &id)?;
    if p.exists() {
        tokio::fs::remove_file(p).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
