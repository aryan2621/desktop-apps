//! Talks to a local Ollama server. Replies are streamed token by token so speech can start
//! before the whole answer is written. Nothing leaves the Mac.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::sync::RwLock;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system", content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user", content: content.into() }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: "assistant", content: content.into() }
    }
}

#[derive(Clone)]
struct Settings {
    base: String,
    model: String,
    keep_alive: String,
}

pub struct Ollama {
    settings: RwLock<Settings>,
    client: reqwest::blocking::Client,
}

impl Ollama {
    pub fn new(base: &str, model: &str, keep_alive: &str) -> Self {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            // Streams can run long; a cold model load alone can take ~10 s.
            .timeout(None)
            .build()
            .expect("http client");
        let ollama = Self { settings: RwLock::new(Settings { base: String::new(), model: String::new(), keep_alive: String::new() }), client };
        ollama.configure(base, model, keep_alive);
        ollama
    }

    /// Applies changed settings; the next request uses them.
    pub fn configure(&self, base: &str, model: &str, keep_alive: &str) {
        *self.settings.write().unwrap() =
            Settings { base: base.trim_end_matches('/').to_string(), model: model.to_string(), keep_alive: keep_alive.to_string() };
    }

    fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }

    /// Names of the installed models (`ollama list`). Errors when Ollama isn't running.
    pub fn models(&self) -> Result<Vec<String>> {
        let base = self.settings().base;
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).build()?;
        let tags: Value = client.get(format!("{base}/api/tags")).send().map_err(|e| self.explain(e))?.json()?;
        let mut names: Vec<String> =
            tags["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(str::to_string)).collect();
        names.sort();
        Ok(names)
    }

    /// Streams a reply. `on_text` gets each new piece and returns false to stop early
    /// (dropping the connection makes Ollama stop generating).
    pub fn chat(&self, messages: &[Message], mut on_text: impl FnMut(&str) -> bool) -> Result<()> {
        // `think: false` skips the hidden reasoning of thinking models (Qwen 3 etc.), which
        // would otherwise add seconds of silence. Older models reject the field, so retry without.
        let resp = match self.post_chat(messages, true) {
            Err(e) if e.to_string().contains("does not support thinking") => self.post_chat(messages, false)?,
            other => other?,
        };
        for line in BufReader::new(resp).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let chunk: Value = serde_json::from_str(&line)?;
            if let Some(err) = chunk["error"].as_str() {
                return Err(anyhow!("Ollama: {err}"));
            }
            if let Some(text) = chunk["message"]["content"].as_str() {
                if !text.is_empty() && !on_text(text) {
                    return Ok(());
                }
            }
            if chunk["done"].as_bool() == Some(true) {
                break;
            }
        }
        Ok(())
    }

    fn post_chat(&self, messages: &[Message], no_think: bool) -> Result<reqwest::blocking::Response> {
        let Settings { base, model, keep_alive } = self.settings();
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "keep_alive": keep_alive,
        });
        if no_think {
            body["think"] = json!(false);
        }
        let resp = self.client.post(format!("{base}/api/chat")).json(&body).send().map_err(|e| self.explain(e))?;
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"].as_str().map(str::to_string))
            .unwrap_or(text);
        if status.as_u16() == 404 && detail.contains("not found") {
            return Err(anyhow!("Model '{model}' isn't installed. Run: ollama pull {model}"));
        }
        Err(anyhow!("Ollama error ({status}): {detail}"))
    }

    /// Loads the model into memory ahead of the first question (an empty chat does just that).
    pub fn warm_up(&self) -> Result<()> {
        let Settings { base, model, keep_alive } = self.settings();
        let body = json!({ "model": model, "messages": [], "keep_alive": keep_alive });
        let resp = self.client.post(format!("{base}/api/chat")).json(&body).send().map_err(|e| self.explain(e))?;
        if resp.status().as_u16() == 404 {
            return Err(anyhow!("Model '{model}' isn't installed. Run: ollama pull {model}"));
        }
        resp.error_for_status()?;
        Ok(())
    }

    pub fn model(&self) -> String {
        self.settings().model
    }

    fn explain(&self, e: reqwest::Error) -> anyhow::Error {
        if e.is_connect() || e.is_timeout() {
            anyhow!("Ollama isn't running. Open the Ollama app (or run: ollama serve)")
        } else {
            anyhow!("Could not reach Ollama: {e}")
        }
    }
}

/// Splits streamed text into speakable sentences as soon as each one is complete.
#[derive(Default)]
pub struct SentenceSplitter {
    buf: String,
}

impl SentenceSplitter {
    /// Adds streamed text and returns any sentences it completed.
    pub fn push(&mut self, text: &str) -> Vec<String> {
        self.buf.push_str(text);
        let mut out = Vec::new();
        while let Some(end) = sentence_end(&self.buf) {
            let sentence: String = self.buf.drain(..end).collect();
            let sentence = sentence.trim();
            if !sentence.is_empty() {
                out.push(sentence.to_string());
            }
        }
        out
    }

    /// Whatever is left once the stream ends.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        let rest = rest.trim();
        (!rest.is_empty()).then(|| rest.to_string())
    }
}

/// Byte index just past the first sentence boundary: `.`/`!`/`?`/`:` followed by whitespace,
/// or a newline. Very short fragments ("e.g.", "Dr.") are not treated as sentences.
fn sentence_end(s: &str) -> Option<usize> {
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let next = chars.peek().map(|&(_, n)| n);
        let boundary = match c {
            '\n' => true,
            '.' | '!' | '?' | ':' | ';' => next.is_some_and(char::is_whitespace),
            _ => false,
        };
        if boundary && (c == '\n' || s[..i].trim().len() >= 12) {
            return Some(i + c.len_utf8());
        }
    }
    None
}

/// Strips markdown and symbols the voice would read out literally ("asterisk asterisk").
pub fn speakable(text: &str) -> String {
    let mut s: String = text.chars().filter(|c| !matches!(c, '*' | '#' | '`' | '_' | '|' | '>')).collect();
    // List markers at the start: "- item", "1. item".
    let trimmed = s.trim_start();
    if let Some(rest) = trimmed.strip_prefix("- ") {
        s = rest.to_string();
    }
    s.trim().to_string()
}
