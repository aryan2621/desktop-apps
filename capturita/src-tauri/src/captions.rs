//! Auto-captions: speech to timed words on this Mac, with Whisper (whisper.cpp + Metal).
//! The editor mixes the recording's audio to 16 kHz mono and sends it here; nothing is uploaded.
//! The speech model is downloaded once, the first time captions are made.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::recording::recordings_root;

/// Whisper large-v3 turbo, 5-bit quantized: near the best accuracy at a fraction of the size.
const MODEL: &str = "large-v3-turbo-q5_0";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
const SAMPLE_RATE: usize = 16_000;
/// Words in near-silent audio are almost always Whisper inventing text ("Thank you.").
const SILENCE_RMS: f32 = 0.002;

#[derive(Default)]
pub struct Captions {
    busy: AtomicBool,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
pub struct Word {
    /// Seconds from the start of the audio (= source time).
    start: f32,
    end: f32,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    downloaded: bool,
    size_mb: u32,
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("ggml-{MODEL}.bin")))
}

fn progress(app: &AppHandle, phase: &str, value: f32) {
    let _ = app.emit("captions-progress", json!({ "phase": phase, "progress": value }));
}

/// Downloads the speech model if it isn't there yet, reporting progress as it goes.
async fn ensure_model(app: &AppHandle, cancel: &AtomicBool) -> Result<PathBuf, String> {
    let path = model_path(app)?;
    if path.exists() {
        return Ok(path);
    }
    let part = path.with_extension("bin.part");
    let mut response = reqwest::get(MODEL_URL).await.map_err(|e| format!("Could not download the speech model: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Could not download the speech model ({})", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let (mut done, mut reported) = (0u64, 0u64);
    progress(app, "download", 0.0);
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("The speech model download failed: {e}"))? {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err("Cancelled".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - reported >= 1 << 20 && total > 0 {
            reported = done;
            progress(app, "download", done as f32 / total as f32);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    if total > 0 && done != total {
        let _ = std::fs::remove_file(&part);
        return Err("The speech model download was incomplete. Please try again.".into());
    }
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Whisper hears up to 30 seconds at a time, but on long stretches of non-English speech over
/// music it tends to give up partway and skip ahead. Windows of about 15 seconds, cut at a quiet
/// moment, keep it on track.
const WINDOW: f32 = 15.0;
/// A stretch of speech longer than a window is cut at the quietest point in its last few seconds.
const CUT_SEARCH: f32 = 5.0;
/// Words Whisper itself rates as likely "not speech" are dropped.
const NO_SPEECH: f32 = 0.8;

/// Splits the audio into windows of at most WINDOW seconds, cut where it's quietest so no word
/// is chopped in half, and trimmed to where there's sound: Whisper invents words like
/// "Thank you." for silence at the start or end of a window. Returns sample ranges.
fn windows(samples: &[f32]) -> Vec<(usize, usize)> {
    let rate = SAMPLE_RATE as f32;
    let total = samples.len() as f32 / rate;
    let mut cuts = vec![0.0f32];
    let mut start = 0.0f32;
    while total - start > WINDOW {
        let from = start + WINDOW - CUT_SEARCH;
        let to = start + WINDOW;
        let mut cut = to;
        let mut quietest = f32::MAX;
        let mut t = from;
        while t + 0.05 <= to {
            let level = rms(samples, t, t + 0.05);
            if level < quietest {
                quietest = level;
                cut = t + 0.025;
            }
            t += 0.05;
        }
        cuts.push(cut);
        start = cut;
    }
    cuts.push(total);
    cuts.windows(2).filter_map(|w| trim_to_sound(samples, w[0], w[1])).collect()
}

/// The part of from..to between the first and last sound (with a little margin), or None if
/// there's less than MIN_SOUND of it: a click or a bump on the mic isn't speech, and Whisper
/// would caption it "Thank you.". A sound is a 50 ms frame clearly above the noise floor.
fn trim_to_sound(samples: &[f32], from: f32, to: f32) -> Option<(usize, usize)> {
    const FRAME: f32 = 0.05;
    const MARGIN: f32 = 0.3;
    const MIN_SOUND: usize = 6;
    let mut count = 0;
    let loud = |t: f32| rms(samples, t, t + FRAME) >= SILENCE_RMS * 4.0;
    let mut first = None;
    let mut last = None;
    let mut t = from;
    while t + FRAME <= to {
        if loud(t) {
            count += 1;
            first.get_or_insert(t);
            last = Some(t + FRAME);
        }
        t += FRAME;
    }
    if count < MIN_SOUND {
        return None;
    }
    let (first, last) = (first?, last?);
    let rate = SAMPLE_RATE as f32;
    Some((((first - MARGIN).max(from) * rate) as usize, ((last + MARGIN).min(to) * rate) as usize))
}

/// Runs Whisper over the audio and returns every word with its timing.
///
/// The audio goes through in windows of about 30 seconds, each a separate pass. With "auto",
/// every window detects its own language: a recording can start in English and go on in Hindi
/// (a narrated video, a call), and forcing one language on all of it makes Whisper invent text.
/// Reports progress: a phase ("load", "transcribe") and 0..1.
pub type Report = Arc<dyn Fn(&str, f32) + Send + Sync>;

pub fn transcribe_words(report: Report, model: PathBuf, audio: Vec<f32>, language: String, cancel: Arc<AtomicBool>) -> Result<Vec<Word>, String> {
    whisper_rs::install_logging_hooks();
    report("load", 0.0);
    let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default()).map_err(|e| format!("Could not load the speech model: {e}"))?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let language = if language.is_empty() { "auto".to_string() } else { language };

    let ranges = windows(&audio);
    let count = ranges.len();
    let mut words = Vec::new();
    report("transcribe", 0.0);
    for (index, &(a, b)) in ranges.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let offset = a as f32 / SAMPLE_RATE as f32;
        let window = &audio[a..b];
        // Nothing to hear: skip the pass (and the text Whisper would invent for silence).
        if rms(window, 0.0, window.len() as f32 / SAMPLE_RATE as f32) < SILENCE_RMS {
            report("transcribe", (index + 1) as f32 / count as f32);
            continue;
        }

        // Beam search: slower than greedy, but far more reliable on accents, mixed languages and music.
        let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
        params.set_language(Some(&language));
        params.set_translate(false);
        params.set_n_threads(std::thread::available_parallelism().map(|n| n.get().min(8) as i32).unwrap_or(4));
        // Each window on its own: carrying text between windows makes Whisper repeat itself.
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_no_speech_thold(0.6);
        // Start and end of every token, to time each word.
        params.set_token_timestamps(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        let window_report = report.clone();
        params.set_progress_callback_safe(move |percent: i32| window_report("transcribe", (index as f32 + percent as f32 / 100.0) / count as f32));
        let abort = cancel.clone();
        // Passed as a boxed closure: that's the type whisper-rs reads the callback back as.
        let abort_callback: Box<dyn FnMut() -> bool> = Box::new(move || abort.load(Ordering::SeqCst));
        params.set_abort_callback_safe(abort_callback);

        // whisper.cpp needs at least a second of audio.
        let mut input = window.to_vec();
        if input.len() < SAMPLE_RATE * 6 / 5 {
            input.resize(SAMPLE_RATE * 6 / 5, 0.0);
        }
        if let Err(e) = state.full(params, &input) {
            return Err(if cancel.load(Ordering::SeqCst) { "Cancelled".into() } else { format!("Transcription failed: {e}") });
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }

        let eot = ctx.token_eot();
        for segment in state.as_iter() {
            // Beam search sometimes emits a zero-length partial copy of the next line; skip it.
            if segment.no_speech_probability() > NO_SPEECH || segment.end_timestamp() <= segment.start_timestamp() {
                continue;
            }
            // Words are built from the tokens' raw bytes and only then turned into text: a letter
            // in Hindi (or any non-Latin script) is often split across two tokens, and decoding
            // tokens one by one turns it into "�". A token starting with a space begins a word.
            let mut word: Vec<u8> = Vec::new();
            let mut word_start = 0.0f32;
            let mut word_end = 0.0f32;
            let flush = |bytes: &mut Vec<u8>, start: f32, end: f32, words: &mut Vec<Word>| {
                let text = String::from_utf8_lossy(bytes).trim().to_string();
                bytes.clear();
                // Skip empty pieces and Whisper's sound tags like "[BLANK_AUDIO]" or "(music)".
                if text.is_empty() || text.starts_with('[') || text.starts_with('(') {
                    return;
                }
                let end = end.max(start + 0.05);
                if rms(&input, start - 0.2, end + 0.2) < SILENCE_RMS {
                    return;
                }
                let (start, end) = tighten(&input, start, end);
                words.push(Word { start: start + offset, end: end + offset, text });
            };
            for i in 0..segment.n_tokens() {
                let Some(token) = segment.get_token(i) else { continue };
                let data = token.token_data();
                // Timestamps, language and other special tokens aren't words.
                if data.id >= eot {
                    continue;
                }
                let Ok(bytes) = token.to_bytes() else { continue };
                if bytes.first() == Some(&b' ') && !word.is_empty() {
                    flush(&mut word, word_start, word_end, &mut words);
                }
                if word.is_empty() {
                    word_start = data.t0 as f32 / 100.0;
                }
                word.extend_from_slice(bytes);
                word_end = data.t1 as f32 / 100.0;
            }
            flush(&mut word, word_start, word_end, &mut words);
        }
    }
    Ok(words)
}

/// Whisper often stretches the first word after a pause back over the silence before it, which
/// would show its caption seconds early. Moves a long word's start and end in to where the
/// voice actually is.
fn tighten(samples: &[f32], start: f32, end: f32) -> (f32, f32) {
    const FRAME: f32 = 0.02;
    if end - start < 0.6 {
        return (start, end);
    }
    let frames: Vec<(f32, f32)> =
        (0..).map(|i| start + i as f32 * FRAME).take_while(|t| *t < end).map(|t| (t, rms(samples, t, t + FRAME))).collect();
    let peak = frames.iter().map(|f| f.1).fold(0.0, f32::max);
    let threshold = (peak * 0.15).max(0.006);
    let first = frames.iter().find(|f| f.1 >= threshold).map_or(start, |f| f.0);
    let last = frames.iter().rev().find(|f| f.1 >= threshold).map_or(end, |f| f.0 + FRAME);
    let (s, e) = ((first - 0.05).max(start), (last + 0.05).min(end));
    if e - s < 0.1 {
        (start, end)
    } else {
        (s, e)
    }
}

fn rms(samples: &[f32], from: f32, to: f32) -> f32 {
    let a = ((from.max(0.0)) * SAMPLE_RATE as f32) as usize;
    let b = ((to * SAMPLE_RATE as f32) as usize).min(samples.len());
    if b <= a {
        return 0.0;
    }
    (samples[a..b].iter().map(|s| s * s).sum::<f32>() / (b - a) as f32).sqrt()
}

#[tauri::command]
pub fn caption_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    Ok(ModelStatus { downloaded: model_path(&app)?.exists(), size_mb: 547 })
}

/// Transcribes 16 kHz mono audio (the body: little-endian f32 samples). Header: `language`.
/// Progress arrives as `captions-progress` events: download → load → transcribe.
#[tauri::command]
pub async fn transcribe(app: AppHandle, captions: State<'_, Captions>, request: Request<'_>) -> Result<Vec<Word>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected audio samples".into());
    };
    let audio: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let language = request.headers().get("language").and_then(|v| v.to_str().ok()).unwrap_or("auto").to_string();
    if captions.busy.swap(true, Ordering::SeqCst) {
        return Err("Captions are already being made".into());
    }
    captions.cancel.store(false, Ordering::SeqCst);
    let cancel = captions.cancel.clone();
    let result = async {
        let model = ensure_model(&app, &cancel).await?;
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || transcribe_words(Arc::new(move |phase: &str, value: f32| progress(&app, phase, value)), model, audio, language, cancel))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    captions.busy.store(false, Ordering::SeqCst);
    result
}

/// Downloads the speech model ahead of time (from setup), with `captions-progress` events.
#[tauri::command]
pub async fn download_caption_model(app: AppHandle, captions: State<'_, Captions>) -> Result<(), String> {
    if captions.busy.swap(true, Ordering::SeqCst) {
        return Err("The speech model is already in use".into());
    }
    captions.cancel.store(false, Ordering::SeqCst);
    let result = ensure_model(&app, &captions.cancel).await.map(|_| ());
    captions.busy.store(false, Ordering::SeqCst);
    result
}

/// Deletes the speech model to free disk space; captions download it again when next needed.
#[tauri::command]
pub fn delete_caption_model(app: AppHandle, captions: State<'_, Captions>) -> Result<(), String> {
    if captions.busy.load(Ordering::SeqCst) {
        return Err("The speech model is in use. Try again when captions are done.".into());
    }
    match std::fs::remove_file(model_path(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn cancel_transcription(captions: State<'_, Captions>) {
    captions.cancel.store(true, Ordering::SeqCst);
}

/// Saves a text file (captions as .srt) in ~/Movies/Capturita/Exports and returns its path.
#[tauri::command]
pub fn save_export_text(app: AppHandle, name: String, extension: String, contents: String) -> Result<String, String> {
    let dir = recordings_root(&app)?.join("Exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '-' })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .to_string();
    let stem = if stem.is_empty() { "Capturita captions".to_string() } else { stem };
    let extension: String = extension.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let mut path = dir.join(format!("{stem}.{extension}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} {n}.{extension}"));
        n += 1;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
