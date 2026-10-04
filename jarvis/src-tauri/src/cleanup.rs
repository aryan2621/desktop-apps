//! Rule-based tidy-up of raw Whisper output. Deliberately conservative: it should never
//! change the meaning of what was said.

use regex::Regex;
use std::sync::LazyLock;

static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]|\*[^*]*\*").unwrap());
static FILLERS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:,\s*)?\b(?:u+m+|u+h+m*|e+r+m+|hm+|mm+)\b,?").unwrap());
static SPACE_BEFORE_PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+([,.!?;:])").unwrap());
static MULTI_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s{2,}").unwrap());
/// "you know" / "I mean" only when set off by commas or opening a sentence before a comma,
/// so "I mean it" and "do you know him" survive.
static SOFT_FILLERS_MID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i),\s*(?:you know|i mean)\s*,").unwrap());
static SOFT_FILLERS_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(^|[.!?]\s+)(?:you know|i mean|so,? like)\s*,\s*(\w)").unwrap());
/// Only an explicit am/pm suffix identifies a time: "at 10.30" can be a price.
static TIME_BEFORE_AMPM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(\d{1,2})\.([0-5]\d)(\s*)(am|pm|a\.m\.|p\.m\.)").unwrap());
static DOUBLE_COMMA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",\s*([,.!?])").unwrap());

/// Phrases Whisper tends to invent on near-silent audio.
const HALLUCINATIONS: &[&str] = &[
    "you", "thank you", "thanks for watching", "thank you for watching", "bye", "okay", "silence",
];

pub fn clean(raw: &str, remove_fillers: bool) -> String {
    let mut s = TAGS.replace_all(raw, " ").into_owned();
    if remove_fillers {
        s = FILLERS.replace_all(&s, "").into_owned();
        s = SOFT_FILLERS_MID.replace_all(&s, "").into_owned();
        s = SOFT_FILLERS_START
            .replace_all(&s, |c: &regex::Captures| format!("{}{}", &c[1], c[2].to_uppercase()))
            .into_owned();
        s = dedupe_words(&s);
    }
    s = TIME_BEFORE_AMPM.replace_all(&s, "$1:$2$3$4").into_owned();
    s = SPACE_BEFORE_PUNCT.replace_all(&s, "$1").into_owned();
    s = DOUBLE_COMMA.replace_all(&s, "$1").into_owned();
    s = MULTI_SPACE.replace_all(&s, " ").into_owned();
    let s = s.trim().trim_start_matches([',', '.', ';', ':']).trim();
    capitalize_first(s)
}

/// True for output that is almost certainly a hallucination on quiet audio.
pub fn is_hallucination(text: &str) -> bool {
    let t = text.trim().trim_matches(|c: char| !c.is_alphanumeric() && c != ' ').to_lowercase();
    t.is_empty() || HALLUCINATIONS.contains(&t.as_str())
}

/// Collapses accidental stutters like "the the" or "I I".
fn dedupe_words(s: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for word in s.split_whitespace() {
        if let Some(prev) = out.last() {
            let prev_plain = prev.trim_end_matches(|c: char| !c.is_alphanumeric());
            let has_punct = prev_plain.len() != prev.len();
            if !has_punct && prev_plain.eq_ignore_ascii_case(word.trim_end_matches(|c: char| !c.is_alphanumeric())) {
                out.pop();
            }
        }
        out.push(word);
    }
    out.join(" ")
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_prices_and_measurements() {
        assert_eq!(clean("tomatoes at 10.30 rupees", true), "Tomatoes at 10.30 rupees");
        assert_eq!(clean("from 1.25 to 2.50", true), "From 1.25 to 2.50");
    }

    #[test]
    fn formats_explicit_times() {
        assert_eq!(clean("at 10.30 pm", true), "At 10:30 pm");
    }
}
