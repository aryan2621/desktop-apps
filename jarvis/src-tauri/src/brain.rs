//! Where answers come from: the built-in AI (llama.cpp's server, bundled with Jarvis and run in
//! the background on a local port) or, if chosen in Settings, an Ollama the user already runs.
//! Both stream replies token by token, and nothing leaves the Mac either way.

use crate::llm::{Message, Ollama};
use crate::model;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Context window for the built-in model: plenty for a spoken conversation.
const CONTEXT_TOKENS: u32 = 8192;
/// Loading the model from disk takes a few seconds; give up if the server isn't up by then.
const START_TIMEOUT: Duration = Duration::from_secs(90);

struct Running {
    child: Child,
    port: u16,
}

/// llama.cpp's server, started on demand and stopped when idle to give its memory back.
pub struct LocalServer {
    running: Mutex<Option<Running>>,
    /// Serialises starts so two questions in a row don't launch two servers.
    starting: Mutex<()>,
    last_used: Mutex<Instant>,
    client: reqwest::blocking::Client,
}

impl LocalServer {
    fn new() -> Self {
        let client = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(3)).timeout(None).build().expect("http client");
        Self { running: Mutex::new(None), starting: Mutex::new(()), last_used: Mutex::new(Instant::now()), client }
    }

    /// The bundled `llama-server`, next to Jarvis's own executable (where Tauri puts sidecars).
    fn executable() -> Result<PathBuf> {
        let exe = std::env::current_exe()?;
        let path = exe.parent().ok_or_else(|| anyhow!("no app folder"))?.join("llama-server");
        if path.exists() {
            Ok(path)
        } else {
            Err(anyhow!("The built-in AI is missing from this copy of Jarvis"))
        }
    }

    fn pid_file() -> PathBuf {
        crate::config::data_dir().join("llama-server.pid")
    }

    /// Port of a running, healthy server, starting one if needed.
    fn ensure(&self) -> Result<u16> {
        *self.last_used.lock().unwrap() = Instant::now();
        if let Some(port) = self.alive_port() {
            return Ok(port);
        }
        let _guard = self.starting.lock().unwrap();
        if let Some(port) = self.alive_port() {
            return Ok(port);
        }
        let model = model::brain_path(&crate::config::data_dir());
        if !model.exists() {
            return Err(anyhow!("The AI model isn't downloaded yet. Open Jarvis and finish setup."));
        }
        kill_leftover();
        let port = free_port()?;
        let log = std::fs::File::create(crate::config::data_dir().join("llama-server.log"))?;
        let started = Instant::now();
        let child = Command::new(Self::executable()?)
            .args(["--model", &model.to_string_lossy()])
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["--ctx-size", &CONTEXT_TOKENS.to_string(), "--n-gpu-layers", "999", "--parallel", "1"])
            // Use the chat template stored in the model file.
            .arg("--jinja")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()?;
        let _ = std::fs::write(Self::pid_file(), child.id().to_string());
        *self.running.lock().unwrap() = Some(Running { child, port });

        // Wait until the model is loaded (/health answers 200).
        while started.elapsed() < START_TIMEOUT {
            if self.exited() {
                self.stop();
                return Err(anyhow!("The built-in AI stopped while starting (see llama-server.log)"));
            }
            if self.client.get(format!("http://127.0.0.1:{port}/health")).send().is_ok_and(|r| r.status().is_success()) {
                mlog!("built-in AI ready in {} ms (port {port})", started.elapsed().as_millis());
                return Ok(port);
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        self.stop();
        Err(anyhow!("The built-in AI took too long to start"))
    }

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

    fn exited(&self) -> bool {
        self.running.lock().unwrap().as_mut().is_none_or(|r| !matches!(r.child.try_wait(), Ok(None)))
    }

    pub fn stop(&self) {
        if let Some(mut r) = self.running.lock().unwrap().take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
            let _ = std::fs::remove_file(Self::pid_file());
            mlog!("built-in AI stopped");
        }
    }

    /// Stops the server after `minutes` without a question (0 = never).
    pub fn stop_if_idle(&self, minutes: u64) {
        if minutes > 0 && self.last_used.lock().unwrap().elapsed() >= Duration::from_secs(minutes * 60) && self.alive_port().is_some() {
            mlog!("built-in AI idle for {minutes} minutes");
            self.stop();
        }
    }

    fn chat(&self, messages: &[Message], mut on_text: impl FnMut(&str) -> bool) -> Result<()> {
        let port = self.ensure()?;
        // Sampling settings Qwen recommends for its instruct models, including the presence
        // penalty it suggests against endless repetition. Spoken answers are short, so the
        // length cap also bounds how long a reply that goes wrong can ramble.
        let body = json!({
            "messages": messages,
            "stream": true,
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "presence_penalty": 1.0,
            "max_tokens": 350,
        });
        let resp = self.client.post(format!("http://127.0.0.1:{port}/v1/chat/completions")).json(&body).send()?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(anyhow!("The built-in AI failed ({status}): {}", resp.text().unwrap_or_default()));
        }
        // Server-sent events: "data: {...}" lines, ending with "data: [DONE]".
        for line in BufReader::new(resp).lines() {
            let line = line?;
            let Some(data) = line.strip_prefix("data: ") else { continue };
            if data.trim() == "[DONE]" {
                break;
            }
            let chunk: Value = serde_json::from_str(data)?;
            if let Some(text) = chunk["choices"][0]["delta"]["content"].as_str() {
                if !text.is_empty() && !on_text(text) {
                    return Ok(());
                }
            }
        }
        *self.last_used.lock().unwrap() = Instant::now();
        Ok(())
    }
}

/// A server left behind by a crash of an earlier Jarvis would hold a few GB of memory: stop it.
fn kill_leftover() {
    let Ok(pid) = std::fs::read_to_string(LocalServer::pid_file()) else { return };
    let pid = pid.trim();
    let is_ours = Command::new("ps").args(["-p", pid, "-o", "comm="]).output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("llama-server"));
    if is_ours {
        let _ = Command::new("kill").arg(pid).status();
        mlog!("stopped a leftover built-in AI (pid {pid})");
    }
    let _ = std::fs::remove_file(LocalServer::pid_file());
}

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// The AI Jarvis answers with, as chosen in Settings.
pub struct Brain {
    pub local: LocalServer,
    pub ollama: Ollama,
    use_ollama: AtomicBool,
}

impl Brain {
    pub fn new(cfg: &crate::config::Config) -> Self {
        let brain = Self { local: LocalServer::new(), ollama: Ollama::new(&cfg.ollama_url, &cfg.llm_model, &cfg.keep_alive), use_ollama: AtomicBool::new(false) };
        brain.configure(cfg);
        brain
    }

    pub fn configure(&self, cfg: &crate::config::Config) {
        self.ollama.configure(&cfg.ollama_url, &cfg.llm_model, &cfg.keep_alive);
        let use_ollama = cfg.brain == "ollama";
        if !self.use_ollama.swap(use_ollama, Ordering::SeqCst) && use_ollama {
            // Switched to Ollama: free the built-in model's memory.
            self.local.stop();
        }
    }

    pub fn uses_ollama(&self) -> bool {
        self.use_ollama.load(Ordering::SeqCst)
    }

    /// Streams a reply; `on_text` returns false to stop early.
    pub fn chat(&self, messages: &[Message], on_text: impl FnMut(&str) -> bool) -> Result<()> {
        if self.uses_ollama() {
            self.ollama.chat(messages, on_text)
        } else {
            self.local.chat(messages, on_text)
        }
    }

    /// Gets the model into memory ahead of the first question.
    pub fn warm_up(&self) -> Result<()> {
        if self.uses_ollama() {
            self.ollama.warm_up()
        } else {
            self.local.ensure().map(|_| ())
        }
    }

    /// Name shown in History.
    pub fn model_name(&self) -> String {
        if self.uses_ollama() {
            self.ollama.model()
        } else {
            model::BRAIN_LABEL.to_string()
        }
    }
}
