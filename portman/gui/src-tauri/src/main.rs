#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;

use auto_launch::AutoLaunchBuilder;
use serde_json::json;
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
};

fn autostart_client(app: &tauri::AppHandle) -> Result<auto_launch::AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_str().ok_or_else(|| "Non-UTF8 executable path".to_string())?;
    let name = app.package_info().name.clone();
    AutoLaunchBuilder::new()
        .set_app_name(&name)
        .set_app_path(exe_str)
        .set_use_launch_agent(true)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    let al = autostart_client(&app)?;
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    let al = autostart_client(&app)?;
    if enabled {
        al.enable().map_err(|e| e.to_string())
    } else {
        al.disable().map_err(|e| e.to_string())
    }
}

/// Opens the OS UI where login items / startup apps are managed (same place users verify autostart).
#[tauri::command]
fn open_startup_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:startupapps"])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        if std::process::Command::new("gnome-control-center")
            .arg("startup")
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        if std::process::Command::new("systemsettings5")
            .args(["--module", "kcm_autostart"])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        return Err(
            "Could not open startup settings. Use your desktop environment's Startup Applications panel."
                .into(),
        );
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        Err("Startup settings are not supported on this platform.".into())
    }
}

fn fallback_python() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

fn resolve_python(root: &std::path::Path) -> PathBuf {
    if let Ok(custom) = std::env::var("PORTMAN_PYTHON") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    let venv = if cfg!(windows) {
        root.join(".venv").join("Scripts").join("python.exe")
    } else {
        root.join(".venv").join("bin").join("python")
    };
    if venv.is_file() {
        venv
    } else {
        PathBuf::from(fallback_python())
    }
}

struct IpcBridge {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl IpcBridge {
    fn rpc(&mut self, method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = RPC_ID.fetch_add(1, Ordering::SeqCst);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        writeln!(self.stdin, "{}", req.to_string()).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        let mut response_line = String::new();
        self.stdout
            .read_line(&mut response_line)
            .map_err(|e| e.to_string())?;

        let trimmed = response_line.trim();
        if trimmed.is_empty() {
            return Err("Empty response from Python IPC".to_string());
        }

        let response: serde_json::Value =
            serde_json::from_str(trimmed).map_err(|e| {
                format!(
                    "Invalid JSON from Python IPC: {} — raw: {:?}",
                    e, response_line
                )
            })?;

        if let Some(err) = response.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("RPC error");
            return Err(msg.to_string());
        }

        response
            .get("result")
            .cloned()
            .ok_or_else(|| "Missing result in RPC response".to_string())
    }
}

static RPC_ID: AtomicU64 = AtomicU64::new(1);

/// The Python core built into one executable (scripts/build-core.sh) and bundled next to the
/// app's own executable, so installed copies don't need Python.
fn bundled_core() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let core = exe.with_file_name(format!("portman-core{}", std::env::consts::EXE_SUFFIX));
    core.is_file().then_some(core)
}

/// The portman source folder this binary was built from, if it still exists (development only;
/// it's baked in at compile time, so it's absent on other machines).
fn workspace_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .ok()
}

fn spawn_ipc_bridge() -> Result<IpcBridge, String> {
    // Prefer the bundled core; PORTMAN_PYTHON forces the Python sources (for working on the core).
    let force_python = std::env::var("PORTMAN_PYTHON").map_or(false, |v| !v.is_empty());
    let (mut command, description) = match (bundled_core(), workspace_root()) {
        (Some(core), _) if !force_python => {
            let description = core.display().to_string();
            (Command::new(core), description)
        }
        (_, Some(root)) => {
            let python = resolve_python(&root);
            let description = python.display().to_string();
            let mut command = Command::new(&python);
            command
                .current_dir(&root)
                .env("PYTHONPATH", root.to_string_lossy().as_ref())
                .arg("-m")
                .arg("core.ipc");
            (command, description)
        }
        _ => return Err("PortMan's core is missing from this install. Please reinstall PortMan.".to_string()),
    };
    #[cfg(windows)]
    {
        // Don't flash a console window for the core.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start PortMan's core ({}): {}", description, e))?;

    let stderr = child.stderr.take().ok_or("No stderr pipe")?;
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => eprintln!("[portman-ipc] {}", l),
                Err(_) => break,
            }
        }
    });

    let stdin = child.stdin.take().ok_or("No stdin pipe")?;
    let stdout = child.stdout.take().ok_or("No stdout pipe")?;
    let stdout = BufReader::new(stdout);

    Ok(IpcBridge { child, stdin, stdout })
}

#[tauri::command]
fn rpc(
    bridge: tauri::State<'_, Mutex<Option<IpcBridge>>>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut guard = bridge.lock().map_err(|e| e.to_string())?;
    let ipc = guard
        .as_mut()
        .ok_or_else(|| "Python IPC is not running".to_string())?;
    ipc.rpc(method, params)
}

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("show", "Show"))
        .add_item(CustomMenuItem::new("refresh", "Refresh"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("quit", "Quit"));

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .manage(Mutex::new(None::<IpcBridge>))
        .setup(|app| {
            match spawn_ipc_bridge() {
                Ok(b) => {
                    *app.state::<Mutex<Option<IpcBridge>>>().lock().unwrap() = Some(b);
                }
                Err(e) => {
                    eprintln!("PortMan: could not start Python IPC: {}", e);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            get_autostart,
            set_autostart,
            open_startup_settings
        ])
        .system_tray(system_tray)
        // Do not handle `LeftClick`: on macOS the same click opens the tray menu, and
        // show+focus here would steal focus / break menu item selection. Use the menu
        // or double-click the tray icon to show the window.
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::DoubleClick { .. } => {
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => {
                match id.as_str() {
                    "show" => {
                        if let Some(w) = app.get_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "refresh" => {
                        if let Some(w) = app.get_window("main") {
                            let _ = w.emit("refresh", ());
                        }
                    }
                    "quit" => {
                        if let Ok(mut g) = app.state::<Mutex<Option<IpcBridge>>>().lock() {
                            if let Some(mut bridge) = g.take() {
                                let _ = bridge.child.kill();
                            }
                        }
                        std::process::exit(0);
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let window = event.window().clone();
                // Hiding a full-screen window leaves its Space behind as a black screen, so leave
                // full screen first and hide once macOS has finished the animation.
                if window.is_fullscreen().unwrap_or(false) {
                    let _ = window.set_fullscreen(false);
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(800));
                        let _ = window.hide();
                    });
                } else {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
