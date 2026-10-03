//! Local log of questions and answers: one JSON object per line in `history.jsonl`.
//! Never leaves the machine.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    /// RFC 3339 local time; also used as the entry's id.
    pub time: String,
    pub question: String,
    pub answer: String,
    /// "quick" (held the key), "conversation" (tapped) or "typed" (from the app window).
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub audio_seconds: f32,
    /// Speech recognition time.
    #[serde(default)]
    pub heard_ms: u64,
    /// From sending the question to the model's first words.
    #[serde(default)]
    pub first_word_ms: u64,
    /// From sending the question to the end of the written answer.
    #[serde(default)]
    pub total_ms: u64,
    #[serde(default)]
    pub model: String,
}

pub fn path() -> PathBuf {
    crate::config::data_dir().join("history.jsonl")
}

pub fn append(entry: &Entry) {
    let Ok(line) = serde_json::to_string(entry) else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path()) {
        let _ = writeln!(f, "{line}");
    }
}

/// All entries, oldest first. Unreadable lines are skipped.
pub fn load() -> Vec<Entry> {
    let Ok(content) = std::fs::read_to_string(path()) else { return vec![] };
    content.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn write_all(entries: &[Entry]) -> anyhow::Result<()> {
    let mut out = String::new();
    for e in entries {
        out.push_str(&serde_json::to_string(e)?);
        out.push('\n');
    }
    std::fs::write(path(), out)?;
    Ok(())
}

/// Newest first, filtered by a case-insensitive substring of the question or answer.
pub fn search(query: &str, limit: usize) -> Vec<Entry> {
    let q = query.trim().to_lowercase();
    load()
        .into_iter()
        .rev()
        .filter(|e| q.is_empty() || e.question.to_lowercase().contains(&q) || e.answer.to_lowercase().contains(&q))
        .take(limit)
        .collect()
}

pub fn delete(time: &str) -> anyhow::Result<()> {
    let entries: Vec<Entry> = load().into_iter().filter(|e| e.time != time).collect();
    write_all(&entries)
}

pub fn clear() -> anyhow::Result<()> {
    write_all(&[])
}
