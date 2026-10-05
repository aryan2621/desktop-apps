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

/// The Whisper models to choose from (the same list as Murmur): id, name, download size in MB,
/// and a note. The first is the default: near the best accuracy at a fraction of the size.
const MODELS: &[(&str, &str, u32, &str)] = &[
    ("large-v3-turbo-q5_0", "Large v3 Turbo", 547, "Recommended: best accuracy for its speed."),
    ("large-v3-turbo", "Large v3 Turbo (full)", 1620, "Marginally more accurate, 3× the size."),
    ("large-v3-q5_0", "Large v3", 1080, "Slower; the most careful with accents and mixed languages."),
    ("small", "Small (multilingual)", 466, "Fast; good for Hindi."),
    ("small.en", "Small (English)", 466, "Fast, English only."),
    ("base.en", "Base (English)", 142, "Very fast, less accurate."),
    ("tiny.en", "Tiny (English)", 75, "Fastest, for older machines."),
];
const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
/// Remembers the chosen model, next to the downloaded models.
const CHOICE_FILE: &str = "caption-model.txt";
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
    id: &'static str,
    label: &'static str,
    note: &'static str,
    size_mb: u32,
    downloaded: bool,
    /// The model captions use.
    selected: bool,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The model with this id, if it's one of ours.
fn find_model(id: &str) -> Result<&'static (&'static str, &'static str, u32, &'static str), String> {
    MODELS.iter().find(|m| m.0 == id).ok_or_else(|| format!("Unknown speech model: {id}"))
}

fn model_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(format!("ggml-{}.bin", find_model(id)?.0)))
}

/// The chosen model's id (the default if none was chosen, or the choice is unknown).
fn selected_model(app: &AppHandle) -> &'static str {
    let chosen = models_dir(app).ok().and_then(|dir| std::fs::read_to_string(dir.join(CHOICE_FILE)).ok()).unwrap_or_default();
    MODELS.iter().find(|m| m.0 == chosen.trim()).map_or(MODELS[0].0, |m| m.0)
}

fn status(app: &AppHandle, model: &'static (&'static str, &'static str, u32, &'static str)) -> ModelStatus {
    ModelStatus {
        id: model.0,
        label: model.1,
        size_mb: model.2,
        note: model.3,
        downloaded: model_path(app, model.0).map(|p| p.exists()).unwrap_or(false),
        selected: selected_model(app) == model.0,
    }
}

fn progress(app: &AppHandle, phase: &str, value: f32) {
    let _ = app.emit("captions-progress", json!({ "phase": phase, "progress": value }));
}

/// Downloads a speech model if it isn't there yet, reporting progress as it goes.
async fn ensure_model(app: &AppHandle, id: &str, cancel: &AtomicBool) -> Result<PathBuf, String> {
    let path = model_path(app, id)?;
    if path.exists() {
        return Ok(path);
    }
    let part = path.with_extension("bin.part");
    let mut response = reqwest::get(format!("{MODEL_BASE_URL}/ggml-{id}.bin")).await.map_err(|e| format!("Could not download the speech model: {e}"))?;
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

/// How loud a 50 ms frame must be to count as sound, for this audio: above its background noise
/// and a small share of its loudest speech, so a quiet microphone's voice still counts while a
/// loud one's breathing and bumps don't. Never below a floor that is silence for any mic, nor
/// above a level that is plainly voice.
fn sound_level(samples: &[f32]) -> f32 {
    const FRAME: f32 = 0.05;
    let total = samples.len() as f32 / SAMPLE_RATE as f32;
    let mut levels: Vec<f32> = (0..(total / FRAME) as usize)
        .map(|i| rms(samples, i as f32 * FRAME, (i + 1) as f32 * FRAME))
        .filter(|&level| level > 0.0)
        .collect();
    if levels.is_empty() {
        return SILENCE_RMS * 4.0;
    }
    levels.sort_by(|a, b| a.total_cmp(b));
    // The quietest fifth of the recording is its background noise; the loudest twentieth, speech.
    let noise = levels[levels.len() / 5];
    let speech = levels[levels.len() * 19 / 20];
    (noise * 4.0).max(speech * 0.08).clamp(SILENCE_RMS, SILENCE_RMS * 4.0)
}

/// Splits the audio into windows of at most WINDOW seconds, cut where it's quietest so no word
/// is chopped in half, and trimmed to where there's sound: Whisper invents words like
/// "Thank you." for silence at the start or end of a window. Returns sample ranges and how many
/// seconds of sound each holds.
fn windows(samples: &[f32], level: f32) -> Vec<(usize, usize, f32)> {
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
            let frame = rms(samples, t, t + 0.05);
            if frame < quietest {
                quietest = frame;
                cut = t + 0.025;
            }
            t += 0.05;
        }
        cuts.push(cut);
        start = cut;
    }
    cuts.push(total);
    cuts.windows(2).filter_map(|w| trim_to_sound(samples, w[0], w[1], level)).collect()
}

/// The part of from..to between the first and last sound (with a little margin), and how many
/// seconds of sound it holds; None if there's less than MIN_SOUND of it: a click or a bump on
/// the mic isn't speech, and Whisper would caption it "Thank you.".
fn trim_to_sound(samples: &[f32], from: f32, to: f32, level: f32) -> Option<(usize, usize, f32)> {
    const FRAME: f32 = 0.05;
    const MARGIN: f32 = 0.3;
    const MIN_SOUND: usize = 6;
    let mut count = 0;
    let mut first = None;
    let mut last = None;
    let mut t = from;
    while t + FRAME <= to {
        if rms(samples, t, t + FRAME) >= level {
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
    Some((((first - MARGIN).max(from) * rate) as usize, ((last + MARGIN).min(to) * rate) as usize, count as f32 * FRAME))
}

/// Reports progress: a phase ("load", "transcribe") and 0..1.
pub type Report = Arc<dyn Fn(&str, f32) + Send + Sync>;

/// A piece with less speech than this may be heard as another language by mistake; it's only
/// allowed to differ from the rest of the track when it's longer.
const LANGUAGE_SWITCH_MIN: f32 = 6.0;

/// Runs Whisper over the audio and returns every word with its timing.
///
/// The audio goes through in windows of about 15 seconds, each a separate pass. With "auto", the
/// language is first detected from the window with the most speech and used for the track; a
/// window may still come out in another language when it holds enough speech to be sure (a
/// recording can start in English and go on in Hindi), but a short one that seems to switch is
/// redone in the track's language, since short stretches are often misheard.
pub fn transcribe_words(report: Report, model: PathBuf, audio: Vec<f32>, language: String, cancel: Arc<AtomicBool>) -> Result<Vec<Word>, String> {
    whisper_rs::install_logging_hooks();
    report("load", 0.0);
    let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default()).map_err(|e| format!("Could not load the speech model: {e}"))?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let language = if language.is_empty() { "auto".to_string() } else { language };
    let eot = ctx.token_eot();

    let level = sound_level(&audio);
    let ranges = windows(&audio, level);
    let count = ranges.len().max(1);
    // The window with the most speech goes first, to settle the track's language.
    let mut order: Vec<usize> = (0..ranges.len()).collect();
    order.sort_by(|&x, &y| ranges[y].2.total_cmp(&ranges[x].2));
    let mut track_language: Option<String> = (language != "auto").then(|| language.clone());

    let mut words = Vec::new();
    report("transcribe", 0.0);
    for (done, &index) in order.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let (a, b, sound) = ranges[index];
        let offset = a as f32 / SAMPLE_RATE as f32;
        // whisper.cpp needs at least a second of audio.
        let mut input = audio[a..b].to_vec();
        if input.len() < SAMPLE_RATE * 6 / 5 {
            input.resize(SAMPLE_RATE * 6 / 5, 0.0);
        }
        let progress = |percent: i32| (done as f32 + percent as f32 / 100.0) / count as f32;

        let pass_language = match &track_language {
            Some(track) if sound < LANGUAGE_SWITCH_MIN => track.clone(),
            _ => "auto".to_string(),
        };
        let mut heard = run_window(&mut state, &input, &pass_language, &report, &progress, &cancel)?;
        let detected = whisper_rs::get_lang_str(state.full_lang_id_from_state()).unwrap_or("").to_string();
        match &track_language {
            None => track_language = Some(detected),
            // Unsure switch on a short window: hear it again in the track's language.
            Some(track) if pass_language == "auto" && &detected != track && sound < LANGUAGE_SWITCH_MIN => {
                heard = run_window(&mut state, &input, track, &report, &progress, &cancel)?;
            }
            _ => {}
        }
        if heard {
            collect_words(&state, eot, &input, offset, level, &mut words)?;
        }
        report("transcribe", (done + 1) as f32 / count as f32);
    }
    words.sort_by(|x, y| x.start.total_cmp(&y.start));
    Ok(words)
}

/// One Whisper pass over a window. Returns false if there was nothing to transcribe.
fn run_window(
    state: &mut whisper_rs::WhisperState,
    input: &[f32],
    language: &str,
    report: &Report,
    progress: &dyn Fn(i32) -> f32,
    cancel: &Arc<AtomicBool>,
) -> Result<bool, String> {
    // Beam search: slower than greedy, but far more reliable on accents, mixed languages and music.
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_language(Some(language));
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
    let steps: Vec<f32> = (0..=100).map(progress).collect();
    params.set_progress_callback_safe(move |percent: i32| window_report("transcribe", steps[percent.clamp(0, 100) as usize]));
    let abort = cancel.clone();
    // Passed as a boxed closure: that's the type whisper-rs reads the callback back as.
    let abort_callback: Box<dyn FnMut() -> bool> = Box::new(move || abort.load(Ordering::SeqCst));
    params.set_abort_callback_safe(abort_callback);
    if let Err(e) = state.full(params, input) {
        return Err(if cancel.load(Ordering::SeqCst) { "Cancelled".into() } else { format!("Transcription failed: {e}") });
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    Ok(true)
}

/// The words of the last pass, with times in the whole recording.
fn collect_words(state: &whisper_rs::WhisperState, eot: i32, input: &[f32], offset: f32, level: f32, words: &mut Vec<Word>) -> Result<(), String> {
    // A word must have some sound under it: Whisper invents text for silence.
    let quiet = (level / 4.0).max(SILENCE_RMS / 4.0);
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
            if rms(input, start - 0.2, end + 0.2) < quiet {
                return;
            }
            let (start, end) = tighten(input, start, end);
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
                flush(&mut word, word_start, word_end, words);
            }
            if word.is_empty() {
                word_start = data.t0 as f32 / 100.0;
            }
            word.extend_from_slice(bytes);
            word_end = data.t1 as f32 / 100.0;
        }
        flush(&mut word, word_start, word_end, words);
    }
    Ok(())
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

/// The model captions use: whether it's downloaded, and its size.
#[tauri::command]
pub fn caption_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    Ok(status(&app, find_model(selected_model(&app))?))
}

/// Every speech model to choose from.
#[tauri::command]
pub fn caption_models(app: AppHandle) -> Vec<ModelStatus> {
    MODELS.iter().map(|m| status(&app, m)).collect()
}

/// Makes captions use this model from now on (it downloads the first time it's needed).
#[tauri::command]
pub fn select_caption_model(app: AppHandle, id: String) -> Result<(), String> {
    let model = find_model(&id)?;
    std::fs::write(models_dir(&app)?.join(CHOICE_FILE), model.0).map_err(|e| e.to_string())
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
    let id = selected_model(&app);
    // English-only models can't detect or transcribe other languages.
    let language = if id.ends_with(".en") { "en".to_string() } else { language };
    let result = async {
        let model = ensure_model(&app, id, &cancel).await?;
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || transcribe_words(Arc::new(move |phase: &str, value: f32| progress(&app, phase, value)), model, audio, language, cancel))
            .await
            .map_err(|e| e.to_string())?
    }
    .await;
    captions.busy.store(false, Ordering::SeqCst);
    result
}

/// Downloads a speech model ahead of time (the chosen one if none is given), with
/// `captions-progress` events.
#[tauri::command]
pub async fn download_caption_model(app: AppHandle, captions: State<'_, Captions>, id: Option<String>) -> Result<(), String> {
    let id = match id {
        Some(id) => find_model(&id)?.0,
        None => selected_model(&app),
    };
    if captions.busy.swap(true, Ordering::SeqCst) {
        return Err("The speech model is already in use".into());
    }
    captions.cancel.store(false, Ordering::SeqCst);
    let result = ensure_model(&app, id, &captions.cancel).await.map(|_| ());
    captions.busy.store(false, Ordering::SeqCst);
    result
}

/// Deletes a speech model (the chosen one if none is given) to free disk space; captions
/// download it again when next needed.
#[tauri::command]
pub fn delete_caption_model(app: AppHandle, captions: State<'_, Captions>, id: Option<String>) -> Result<(), String> {
    if captions.busy.load(Ordering::SeqCst) {
        return Err("The speech model is in use. Try again when captions are done.".into());
    }
    let id = match id {
        Some(id) => find_model(&id)?.0,
        None => selected_model(&app),
    };
    match std::fs::remove_file(model_path(&app, id)?) {
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
