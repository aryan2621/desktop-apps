//! Writes exported MP4 files. The webview renders and encodes the video, then streams the file
//! here in binary chunks (with their byte position), so a long export never has to fit in memory.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};

use crate::recording::recordings_root;

#[derive(Default)]
pub struct Export {
    file: Mutex<Option<(PathBuf, File)>>,
}

/// Starts a new export file (`mp4` or `gif`) in ~/Movies/Capturita/Exports and returns its path.
#[tauri::command]
pub fn export_open(app: AppHandle, export: State<'_, Export>, name: String, ext: Option<String>) -> Result<String, String> {
    let ext = match ext.as_deref() {
        Some("gif") => "gif",
        _ => "mp4",
    };
    let dir = recordings_root(&app)?.join("Exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Keep only characters that are safe in a file name.
    let stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '-' })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .to_string();
    let stem = if stem.is_empty() { "Capturita export".to_string() } else { stem };
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} {n}.{ext}"));
        n += 1;
    }
    let file = File::create(&path).map_err(|e| e.to_string())?;
    *export.file.lock().unwrap() = Some((path.clone(), file));
    Ok(path.to_string_lossy().into_owned())
}

/// Writes one chunk. The body is raw bytes; the `position` header says where they go.
#[tauri::command]
pub fn export_write(export: State<'_, Export>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let position: u64 = request
        .headers()
        .get("position")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("Missing position header")?;
    let mut guard = export.file.lock().unwrap();
    let (_, file) = guard.as_mut().ok_or("No export in progress")?;
    file.seek(SeekFrom::Start(position)).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

/// Finishes the export. A cancelled or failed export's partial file is deleted.
#[tauri::command]
pub fn export_close(export: State<'_, Export>, keep: bool) -> Result<(), String> {
    let Some((path, mut file)) = export.file.lock().unwrap().take() else {
        return Ok(());
    };
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if !keep {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Puts the exported file on the clipboard as a file (like ⌘C in Finder), so it can be pasted
/// into Slack, Mail, Messages or a Finder window.
#[tauri::command]
pub fn copy_file_to_clipboard(app: AppHandle, path: String) -> Result<(), String> {
    let only_exports = || "Only exported files can be copied".to_string();
    let exports = std::fs::canonicalize(recordings_root(&app)?.join("Exports")).map_err(|_| only_exports())?;
    let file = std::fs::canonicalize(&path).map_err(|_| only_exports())?;
    if !file.starts_with(&exports) || !file.is_file() {
        return Err(only_exports());
    }
    let path = file.to_string_lossy().into_owned();
    // AppleScript string literal: escape backslashes and quotes.
    let quoted = path.replace('\\', "\\\\").replace('"', "\\\"");
    let status = std::process::Command::new("osascript")
        .args(["-e", &format!("set the clipboard to (POSIX file \"{quoted}\")")])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not copy the file to the clipboard".into())
    }
}
