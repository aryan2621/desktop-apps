//! Talks to the Swift capture helper (`recorder/`), which runs as a Tauri sidecar.
//! Protocol: one JSON object per line on stdin/stdout. Requests carry an `id` and get a
//! reply with the same `id`; messages with an `event` field are pushed by the helper.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

type Reply = Result<Value, String>;

#[derive(Default)]
pub struct Helper {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
}

impl Helper {
    pub async fn call(&self, app: &AppHandle, cmd: &str, args: Value, timeout: Option<Duration>) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let mut line = serde_json::to_vec(&json!({ "id": id, "cmd": cmd, "args": args })).map_err(|e| e.to_string())?;
        line.push(b'\n');
        if let Err(error) = self.write(app, line) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }

        let reply = match timeout {
            Some(limit) => match tokio::time::timeout(limit, rx).await {
                Ok(result) => result,
                Err(_) => {
                    self.pending.lock().unwrap().remove(&id);
                    return Err(format!("The recorder did not answer `{cmd}` in time"));
                }
            },
            None => rx.await,
        };
        reply.unwrap_or_else(|_| Err("The recorder stopped unexpectedly".into()))
    }

    fn write(&self, app: &AppHandle, line: Vec<u8>) -> Result<(), String> {
        let mut child = self.child.lock().unwrap();
        if child.is_none() {
            *child = Some(spawn(app)?);
        }
        child.as_mut().unwrap().write(&line).map_err(|e| format!("Could not reach the recorder: {e}"))
    }

    fn resolve(&self, message: &Value) {
        let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
        let Some(tx) = self.pending.lock().unwrap().remove(&id) else { return };
        let reply = if message.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(message.get("error").and_then(Value::as_str).unwrap_or("Unknown recorder error").to_string())
        };
        let _ = tx.send(reply);
    }

    fn terminated(&self) {
        *self.child.lock().unwrap() = None;
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err("The recorder stopped unexpectedly".into()));
        }
    }
}

fn spawn(app: &AppHandle) -> Result<CommandChild, String> {
    let (mut events, child) = app
        .shell()
        .sidecar("capturita-recorder")
        // Pass the "film Capturita itself" switch on to the capture helper.
        .map(|command| match std::env::var("CAPTURITA_KEEP_WINDOW") {
            Ok(value) => command.env("CAPTURITA_KEEP_WINDOW", value),
            Err(_) => command,
        })
        .and_then(|command| command.spawn())
        .map_err(|e| format!("Could not start the recorder: {e}"))?;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(chunk) => {
                    buffer.extend_from_slice(&chunk);
                    // Lines may arrive split or batched; only parse complete ones.
                    while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=end).collect();
                        handle_line(&app, &line);
                    }
                    if !buffer.is_empty() && serde_json::from_slice::<Value>(&buffer).is_ok() {
                        let line = std::mem::take(&mut buffer);
                        handle_line(&app, &line);
                    }
                }
                CommandEvent::Stderr(line) => eprintln!("{}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Terminated(status) => {
                    eprintln!("[recorder] exited: {status:?}");
                    app.state::<Helper>().terminated();
                    crate::recording::on_helper_exit(&app);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(child)
}

fn handle_line(app: &AppHandle, line: &[u8]) {
    let text = String::from_utf8_lossy(line);
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        eprintln!("[recorder] unexpected output: {text}");
        return;
    };
    if message.get("id").is_some() {
        app.state::<Helper>().resolve(&message);
    } else if let Some(event) = message.get("event").and_then(Value::as_str) {
        let data = message.get("data").cloned().unwrap_or(Value::Null);
        match event {
            "recordingFinished" => crate::recording::finish(app, Ok(data)),
            "barAction" => {
                if let Some(action) = data.get("action").and_then(Value::as_str) {
                    crate::recording::bar_action(app, action);
                }
            }
            "recordingFailed" => {
                let reason = data.get("message").and_then(Value::as_str).unwrap_or("Recording failed").to_string();
                crate::recording::finish(app, Err(reason));
            }
            _ => {
                let _ = app.emit("recorder-event", json!({ "event": event, "data": data }));
            }
        }
    }
}
