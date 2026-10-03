/// Log to stderr and to `jarvis.log` in the data dir (the app has no console when launched normally).
macro_rules! mlog {
    ($($t:tt)*) => { $crate::config::log(&format!($($t)*)) };
}

mod audio;
mod cleanup;
mod commands;
mod config;
mod gesture;
mod history;
mod hotkey;
mod llm;
mod model;
mod permission;
mod speech;
mod transcribe;

use audio::Recorder;
use config::Config;
use hotkey::HotkeyEvent;
use llm::{Message, Ollama, SentenceSplitter};
use serde::Serialize;
use speech::Speaker;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use transcribe::Transcriber;

/// Clips shorter than this are treated as accidental taps.
const MIN_SECONDS: f32 = 0.3;
/// Below this peak RMS the clip is considered silence (prevents Whisper hallucinations).
const SILENCE_RMS: f32 = 0.006;
/// Don't ask Ollama to load the model more often than this.
const WARM_UP_EVERY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Idle,
    Recording,
    /// Transcribing, thinking or speaking. A hotkey press interrupts it.
    Responding,
}

#[derive(Serialize, Clone)]
struct WidgetState<'a> {
    state: &'a str,
    message: Option<String>,
    progress: Option<f32>,
    question: Option<&'a str>,
    reply: Option<&'a str>,
}

/// Hotkey timing state used to tell holds from taps.
#[derive(Default)]
struct Gesture {
    pressed_at: Option<Instant>,
    /// This press cut off an answer; if it's only a tap, stopping was the whole point.
    interrupted: bool,
    /// This press was handled on the way down (e.g. it ended a conversation); skip its release.
    ignore_release: bool,
}

/// Voice activity detection for conversation mode: notices when you've finished speaking.
struct Vad {
    started: Instant,
    last_tick: Instant,
    last_voice: Instant,
    /// Accumulated loud time; speech counts as started once it passes `MIN_SPEECH`.
    voice: Duration,
    heard_speech: bool,
    /// Recent levels; the quietest of them is the room's background noise (a fan, AC or
    /// traffic sets it, while the gaps between words don't fool it).
    recent: std::collections::VecDeque<(Instant, f32)>,
    /// Typical level of your voice (average of loud moments); 0 until you speak.
    speech_level: f32,
    /// Loudest level heard, for the log.
    peak: f32,
    /// A decision (send / give up) has been made for this recording.
    decided: bool,
}

impl Vad {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            started: now,
            last_tick: now,
            last_voice: now,
            voice: Duration::ZERO,
            heard_speech: false,
            recent: std::collections::VecDeque::new(),
            speech_level: 0.0,
            peak: 0.0,
            decided: false,
        }
    }

    fn noise_floor(&self) -> f32 {
        self.recent.iter().map(|&(_, l)| l).fold(f32::MAX, f32::min).min(1.0)
    }
}

/// What the level meter decided about the current conversation-mode recording.
enum VadDecision {
    Continue,
    /// You stopped talking: send it.
    Send,
    /// Nothing said for a while: end the conversation.
    GiveUp,
}

/// Loud time needed before a recording counts as speech (filters out clicks and coughs).
const MIN_SPEECH: Duration = Duration::from_millis(250);
/// Longest single utterance in conversation mode before it is sent anyway.
const MAX_UTTERANCE: Duration = Duration::from_secs(45);
/// How far back the background-noise estimate looks.
const NOISE_WINDOW: Duration = Duration::from_secs(3);
/// Speech must be this many times louder than the background.
const SPEECH_OVER_NOISE: f32 = 2.5;
/// Pause after Jarvis stops speaking before the mic reopens, so it doesn't hear its own echo.
const ECHO_GUARD: Duration = Duration::from_millis(300);

/// Recent questions and answers, sent back to the model so follow-ups make sense.
#[derive(Default)]
struct Conversation {
    messages: Vec<Message>,
    last_at: Option<Instant>,
}

struct Core {
    app: AppHandle,
    cfg: RwLock<Config>,
    recorder: Recorder,
    transcriber: Mutex<Option<Arc<Transcriber>>>,
    ollama: Ollama,
    speaker: Speaker,
    conversation: Mutex<Conversation>,
    phase: Mutex<Phase>,
    /// Bumped on every interruption; a response thread whose turn is stale goes quiet.
    turn: AtomicU64,
    gesture: Mutex<Gesture>,
    /// Conversation mode: listen, answer, listen again, until ended.
    in_conversation: AtomicBool,
    vad: Mutex<Vad>,
    status_item: MenuItem<Wry>,
    /// Same text as the menu bar status line, for the app window.
    status: Mutex<String>,
    last_warm_up: Mutex<Option<Instant>>,
}

impl Core {
    fn cfg(&self) -> Config {
        self.cfg.read().unwrap().clone()
    }

    fn widget(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window("widget")
    }

    fn set_status(&self, text: &str) {
        let _ = self.status_item.set_text(text);
        *self.status.lock().unwrap() = text.to_string();
        let _ = self.app.emit_to("main", "status", text);
    }

    fn ready_status(&self) {
        if permission::has_accessibility(false) {
            self.set_status(&format!("Ready — hold {} to ask", key_label(&self.cfg().hotkey)));
        } else {
            self.set_status("Allow Jarvis in Privacy & Security → Accessibility");
        }
    }

    /// The loaded Whisper model, loading it first if needed.
    fn ensure_transcriber(&self) -> anyhow::Result<Arc<Transcriber>> {
        if let Some(t) = self.transcriber.lock().unwrap().clone() {
            return Ok(t);
        }
        Err(anyhow::anyhow!("Speech model is still loading"))
    }

    fn phase(&self) -> Phase {
        *self.phase.lock().unwrap()
    }

    fn set_phase(&self, p: Phase) {
        *self.phase.lock().unwrap() = p;
    }

    fn current(&self, turn: u64) -> bool {
        self.turn.load(Ordering::SeqCst) == turn
    }

    /// Stops whatever is being said or generated. Done under the phase lock so a response
    /// thread that is just finishing can't overwrite the new phase.
    fn interrupt(&self) {
        let mut phase = self.phase.lock().unwrap();
        self.turn.fetch_add(1, Ordering::SeqCst);
        self.speaker.stop();
        if *phase == Phase::Responding {
            *phase = Phase::Idle;
        }
    }

    /// Ends a response, unless it was interrupted. Returns false if it was.
    fn finish_turn(&self, turn: u64) -> bool {
        let mut phase = self.phase.lock().unwrap();
        if self.current(turn) && *phase == Phase::Responding {
            *phase = Phase::Idle;
            true
        } else {
            false
        }
    }

    fn emit(&self, state: &str, message: Option<String>, progress: Option<f32>) {
        let _ = self.app.emit_to("widget", "widget-state", WidgetState { state, message, progress, question: None, reply: None });
    }

    /// Live answer for the widget and the app window's Home page.
    fn emit_reply(&self, turn: u64, state: &str, question: &str, reply: &str) {
        if self.current(turn) {
            let payload = WidgetState { state, message: None, progress: None, question: Some(question), reply: Some(reply) };
            let _ = self.app.emit_to("widget", "widget-state", &payload);
            let _ = self.app.emit_to("main", "reply", &payload);
        }
    }

    fn show_widget(&self) {
        let Some(w) = self.widget() else {
            mlog!("widget: window not found");
            return;
        };
        place_widget(&self.app, &w);
        show_without_focus(&w);
    }

    fn play(&self, sound: &str) {
        if self.cfg().sounds {
            play_sound(sound);
        }
    }

    /// Hides after `delay`, unless something new started in the meantime.
    fn hide_widget_later(self: &Arc<Self>, delay: Duration) {
        let core = self.clone();
        let turn = self.turn.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if core.current(turn) && matches!(core.phase(), Phase::Idle | Phase::Loading) {
                if let Some(w) = core.widget() {
                    hide_widget(&w);
                }
            }
        });
    }

    fn conversing(&self) -> bool {
        self.in_conversation.load(Ordering::SeqCst)
    }

    /// Returns true when the event was consumed (only matters for Esc).
    fn on_hotkey(self: &Arc<Self>, event: HotkeyEvent) -> bool {
        let now = Instant::now();
        match event {
            HotkeyEvent::Pressed => {
                let phase = self.phase();
                if self.conversing() {
                    // Tap while it talks: stop it and listen. Tap while it listens: end.
                    self.gesture.lock().unwrap().ignore_release = true;
                    if phase == Phase::Responding {
                        mlog!("interrupted (conversation continues)");
                        self.interrupt();
                        self.listen(true);
                    } else {
                        self.end_conversation("ended with the hotkey");
                    }
                    return false;
                }
                if matches!(phase, Phase::Idle | Phase::Responding) {
                    {
                        let mut g = self.gesture.lock().unwrap();
                        g.pressed_at = Some(now);
                        g.interrupted = phase == Phase::Responding;
                    }
                    if phase == Phase::Responding {
                        mlog!("interrupted");
                        self.interrupt();
                    }
                    if self.start_recording() {
                        self.start_hold_widget();
                    }
                } else if phase == Phase::Loading {
                    self.emit("error", Some("Still loading…".into()), None);
                    self.show_widget();
                    self.hide_widget_later(Duration::from_millis(1500));
                }
                false
            }
            HotkeyEvent::Released => {
                let mut g = self.gesture.lock().unwrap();
                if std::mem::take(&mut g.ignore_release) || self.conversing() || self.phase() != Phase::Recording {
                    return false;
                }
                let held = g.pressed_at.map(|t| now - t).unwrap_or_default();
                let interrupted = g.interrupted;
                drop(g);
                if !gesture::is_tap(held) {
                    mlog!("hotkey held {} ms → quick question", held.as_millis());
                    self.finish_recording();
                } else if interrupted {
                    // The tap was only to stop the answer.
                    self.cancel_recording();
                } else {
                    mlog!("hotkey tapped → conversation");
                    self.start_conversation();
                }
                false
            }
            HotkeyEvent::Cancelled => {
                if !self.conversing() {
                    self.cancel_recording();
                }
                false
            }
            HotkeyEvent::Escape => {
                if self.conversing() {
                    self.end_conversation("ended with Esc");
                    return true;
                }
                match self.phase() {
                    Phase::Recording => {
                        mlog!("cancelled with Esc");
                        self.cancel_recording();
                        true
                    }
                    Phase::Responding => {
                        mlog!("stopped with Esc");
                        self.interrupt();
                        if let Some(w) = self.widget() {
                            hide_widget(&w);
                        }
                        true
                    }
                    _ => false,
                }
            }
        }
    }

    /// Opens the mic. In conversation mode the level meter also watches for the end of speech.
    fn start_recording(self: &Arc<Self>) -> bool {
        self.set_phase(Phase::Recording);
        *self.vad.lock().unwrap() = Vad::new();
        let core = self.clone();
        let on_level = Box::new(move |level: f32| {
            let _ = core.app.emit_to("widget", "level", level);
            if core.conversing() {
                core.on_level(level);
            }
        });
        if let Err(e) = self.recorder.start(self.cfg().input_device, on_level) {
            self.set_phase(Phase::Idle);
            self.in_conversation.store(false, Ordering::SeqCst);
            self.fail(&format!("Mic error: {e}"));
            return false;
        }
        self.warm_up_llm();
        true
    }

    /// Quick question: the recording runs while the key is held.
    fn start_hold_widget(self: &Arc<Self>) {
        self.emit("recording", None, None);
        // Show only if this turns out to be a hold, so quick taps never flash the widget.
        let core = self.clone();
        let pressed_at = self.gesture.lock().unwrap().pressed_at;
        std::thread::spawn(move || {
            std::thread::sleep(gesture::SHOW_DELAY);
            let same_press = core.gesture.lock().unwrap().pressed_at == pressed_at;
            if core.phase() == Phase::Recording && same_press && !core.conversing() {
                core.show_widget();
                core.play("Tink");
            }
        });
    }

    /// The tap's recording keeps running; from now on a pause sends it.
    fn start_conversation(self: &Arc<Self>) {
        self.in_conversation.store(true, Ordering::SeqCst);
        // Count from now: the tap itself isn't speech.
        *self.vad.lock().unwrap() = Vad::new();
        self.emit("listening", None, None);
        self.show_widget();
        self.play("Tink");
        self.set_status(&format!("In conversation — tap {} to end", key_label(&self.cfg().hotkey)));
    }

    /// Conversation mode: open the mic for the next thing the user says.
    fn listen(self: &Arc<Self>, immediately: bool) {
        if !immediately {
            std::thread::sleep(ECHO_GUARD);
        }
        if !self.conversing() || !matches!(self.phase(), Phase::Idle | Phase::Responding) {
            return;
        }
        if self.start_recording() {
            self.emit("listening", None, None);
            self.show_widget();
        }
    }

    fn end_conversation(self: &Arc<Self>, why: &str) {
        if !self.in_conversation.swap(false, Ordering::SeqCst) {
            return;
        }
        mlog!("conversation {why}");
        self.interrupt();
        if self.phase() == Phase::Recording {
            let _ = self.recorder.stop();
            self.set_phase(Phase::Idle);
        }
        self.play("Bottle");
        self.ready_status();
        if let Some(w) = self.widget() {
            hide_widget(&w);
        }
    }

    /// Called ~30 times a second with the mic level while conversing.
    fn on_level(self: &Arc<Self>, level: f32) {
        let decision = {
            let cfg = self.cfg.read().unwrap();
            let mut v = self.vad.lock().unwrap();
            if v.decided {
                return;
            }
            let now = Instant::now();
            let dt = now - v.last_tick;
            v.last_tick = now;
            v.recent.push_back((now, level));
            while v.recent.front().is_some_and(|&(t, _)| now - t > NOISE_WINDOW) {
                v.recent.pop_front();
            }
            v.peak = v.peak.max(level);
            // Speech = clearly louder than the room. In a quiet room the configured threshold
            // decides; with a fan or AC running, the measured background does.
            // Capped at half your speaking level, so a long unbroken sentence can't raise the
            // background estimate high enough to cut you off; but always clear of the noise's
            // own peaks, or a loud room would never count as a pause.
            let floor = v.noise_floor();
            let mut over_noise = floor * SPEECH_OVER_NOISE;
            if v.speech_level > 0.0 {
                over_noise = over_noise.min(v.speech_level * 0.5).max(floor * 1.5);
            }
            let threshold = cfg.speech_threshold.max(over_noise);
            if level > threshold {
                v.speech_level = if v.speech_level == 0.0 { level } else { v.speech_level * 0.9 + level * 0.1 };
                v.voice += dt;
                v.last_voice = now;
                if v.voice >= MIN_SPEECH {
                    v.heard_speech = true;
                }
            } else if !v.heard_speech {
                // Isolated blips fade instead of adding up to "speech".
                v.voice = v.voice.saturating_sub(dt / 2);
            }
            let pause = Duration::from_secs_f32(cfg.pause_seconds.max(0.4));
            let long = now - v.started >= MAX_UTTERANCE;
            let decision = if v.heard_speech && (now - v.last_voice >= pause || long) {
                VadDecision::Send
            } else if !v.heard_speech && now - v.started >= Duration::from_secs(cfg.conversation_timeout_seconds.max(3) as u64) {
                VadDecision::GiveUp
            } else {
                VadDecision::Continue
            };
            if !matches!(decision, VadDecision::Continue) {
                v.decided = true;
                mlog!(
                    "vad: {} after {:.1}s — background {floor:.4}, threshold {threshold:.4}, voice {:.4}, loudest {:.4}",
                    match decision {
                        VadDecision::Send if long => "sent at the length limit",
                        VadDecision::Send => "pause detected",
                        _ => "no speech",
                    },
                    (now - v.started).as_secs_f32(),
                    v.speech_level,
                    v.peak
                );
            }
            decision
        };
        // Stopping the mic from inside its own callback would deadlock: hand it off.
        let core = self.clone();
        match decision {
            VadDecision::Send => {
                std::thread::spawn(move || core.finish_recording());
            }
            VadDecision::GiveUp => {
                std::thread::spawn(move || core.end_conversation("timed out"));
            }
            VadDecision::Continue => {}
        }
    }

    fn cancel_recording(self: &Arc<Self>) {
        if self.phase() != Phase::Recording {
            return;
        }
        let _ = self.recorder.stop();
        self.set_phase(Phase::Idle);
        if let Some(w) = self.widget() {
            hide_widget(&w);
        }
    }

    fn finish_recording(self: &Arc<Self>) {
        if self.phase() != Phase::Recording {
            return;
        }
        self.set_phase(Phase::Responding);
        self.play("Pop");
        let turn = self.turn.load(Ordering::SeqCst);
        let core = self.clone();
        std::thread::spawn(move || {
            let result = core.respond(turn);
            if !core.finish_turn(turn) {
                return;
            }
            match result {
                Ok(_) if core.conversing() => core.listen(false),
                Ok(hide_after) => core.hide_widget_later(hide_after),
                Err(e) => {
                    core.in_conversation.store(false, Ordering::SeqCst);
                    core.ready_status();
                    core.fail(&e.to_string());
                }
            }
        });
    }

    /// Recording → question → streamed answer, spoken sentence by sentence.
    /// Returns how long to keep the answer on screen afterwards.
    fn respond(&self, turn: u64) -> anyhow::Result<Duration> {
        let rec = self.recorder.stop()?;
        if rec.seconds() < MIN_SECONDS || rec.peak_rms < SILENCE_RMS {
            mlog!("skipped clip ({:.2}s, peak rms {:.4})", rec.seconds(), rec.peak_rms);
            return Ok(Duration::ZERO);
        }
        self.emit("transcribing", None, None);
        let cfg = self.cfg();
        let transcriber = self.ensure_transcriber()?;
        let t0 = Instant::now();
        let raw = transcriber.transcribe(&rec.samples, &cfg.language, false, &[])?;
        let heard_ms = t0.elapsed().as_millis();
        if cleanup::is_hallucination(&raw) {
            return Ok(Duration::ZERO);
        }
        let question = cleanup::clean(&raw, true);
        if question.is_empty() || !self.current(turn) {
            return Ok(Duration::ZERO);
        }
        mlog!("heard ({:.1}s audio, {heard_ms} ms): {question}", rec.seconds());
        let mode = if self.conversing() { "conversation" } else { "quick" };
        self.answer(turn, &question, mode, rec.seconds(), heard_ms as u64)
    }

    /// Streams the model's answer to `question`, speaking it sentence by sentence, and logs it.
    /// Returns how long to keep the answer on screen afterwards.
    fn answer(&self, turn: u64, question: &str, mode: &str, audio_seconds: f32, heard_ms: u64) -> anyhow::Result<Duration> {
        let cfg = self.cfg();
        self.emit_reply(turn, "thinking", question, "");
        let messages = self.messages_for(&cfg, question);
        let mut reply = String::new();
        let mut splitter = SentenceSplitter::default();
        let mut first_token_ms = None;
        let t1 = Instant::now();
        let result = self.ollama.chat(&messages, |piece| {
            if !self.current(turn) {
                return false;
            }
            first_token_ms.get_or_insert(t1.elapsed().as_millis());
            reply.push_str(piece);
            if cfg.speak_replies {
                for sentence in splitter.push(piece) {
                    self.speaker.say(&llm::speakable(&sentence));
                }
            }
            self.emit_reply(turn, "speaking", question, reply.trim());
            true
        });
        if cfg.speak_replies && self.current(turn) {
            if let Some(rest) = splitter.finish() {
                self.speaker.say(&llm::speakable(&rest));
            }
        }
        // Keep even a cut-off answer, so "what were you saying?" works.
        let total_ms = t1.elapsed().as_millis() as u64;
        if !reply.trim().is_empty() {
            self.remember(question, reply.trim());
            if cfg.save_history {
                history::append(&history::Entry {
                    time: chrono::Local::now().to_rfc3339(),
                    question: question.to_string(),
                    answer: reply.trim().to_string(),
                    mode: mode.to_string(),
                    audio_seconds,
                    heard_ms,
                    first_word_ms: first_token_ms.unwrap_or_default() as u64,
                    total_ms,
                    model: self.ollama.model(),
                });
                let _ = self.app.emit_to("main", "history-updated", ());
            }
        }
        result?;
        if !self.current(turn) {
            return Ok(Duration::ZERO);
        }
        if reply.trim().is_empty() {
            return Err(anyhow::anyhow!("The model gave an empty answer"));
        }
        mlog!(
            "answered: first words after {} ms, full reply in {} ms ({} chars)",
            first_token_ms.unwrap_or_default(),
            total_ms,
            reply.trim().len()
        );
        self.emit_reply(turn, "done", question, reply.trim());
        if !self.conversing() {
            self.ready_status();
        }
        if cfg.speak_replies {
            self.speaker.wait(|| self.current(turn));
            Ok(Duration::from_millis(1500))
        } else {
            // Long enough to read it.
            let ms = (reply.len() as u64 * 60).clamp(3000, 15000);
            Ok(Duration::from_millis(ms))
        }
    }

    /// A question typed in the app window: answered (and spoken) like a spoken one.
    fn ask_typed(self: &Arc<Self>, question: &str) -> anyhow::Result<()> {
        if question.is_empty() {
            return Ok(());
        }
        match self.phase() {
            Phase::Loading => return Err(anyhow::anyhow!("Still loading, try again in a moment")),
            Phase::Recording => return Err(anyhow::anyhow!("Jarvis is listening right now")),
            Phase::Responding => self.interrupt(),
            Phase::Idle => {}
        }
        self.set_phase(Phase::Responding);
        let turn = self.turn.load(Ordering::SeqCst);
        let core = self.clone();
        let question = question.to_string();
        std::thread::spawn(move || {
            let result = core.answer(turn, &question, "typed", 0.0, 0);
            if core.finish_turn(turn) {
                if let Err(e) = result {
                    let _ = core.app.emit_to("main", "reply-error", e.to_string());
                    mlog!("{e}");
                }
            }
        });
        Ok(())
    }

    /// Stop button in the app window: ends a conversation or cuts off the current answer.
    fn stop_all(self: &Arc<Self>) {
        if self.conversing() {
            self.end_conversation("ended from the app window");
        } else {
            self.interrupt();
            if let Some(w) = self.widget() {
                hide_widget(&w);
            }
        }
    }

    /// System prompt + recent conversation + the new question. Starts over after a quiet spell.
    fn messages_for(&self, cfg: &Config, question: &str) -> Vec<Message> {
        let mut conv = self.conversation.lock().unwrap();
        let forget = Duration::from_secs(cfg.forget_after_minutes as u64 * 60);
        if conv.last_at.is_some_and(|t| t.elapsed() > forget) && !conv.messages.is_empty() {
            mlog!("starting a new conversation after {} quiet minutes", cfg.forget_after_minutes);
            conv.messages.clear();
        }
        let keep = cfg.history_turns * 2;
        let skip = conv.messages.len().saturating_sub(keep);
        let mut messages = vec![Message::system(system_prompt(cfg))];
        messages.extend(conv.messages[skip..].iter().cloned());
        messages.push(Message::user(question));
        messages
    }

    fn remember(&self, question: &str, reply: &str) {
        let mut conv = self.conversation.lock().unwrap();
        conv.messages.push(Message::user(question));
        conv.messages.push(Message::assistant(reply));
        conv.last_at = Some(Instant::now());
        let keep = self.cfg().history_turns * 2;
        let excess = conv.messages.len().saturating_sub(keep);
        conv.messages.drain(..excess);
    }

    fn new_conversation(&self) {
        *self.conversation.lock().unwrap() = Conversation::default();
        mlog!("new conversation");
    }

    /// Asks Ollama to load the model in the background, so it's ready by the time the
    /// question is transcribed. Cheap when it's already loaded.
    fn warm_up_llm(self: &Arc<Self>) {
        {
            let mut last = self.last_warm_up.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < WARM_UP_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        let core = self.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            match core.ollama.warm_up() {
                Ok(()) => mlog!("ollama ready ({} ms)", started.elapsed().as_millis()),
                Err(e) => {
                    mlog!("ollama: {e}");
                    core.set_status(&e.to_string());
                    // Try again on the next press.
                    *core.last_warm_up.lock().unwrap() = None;
                }
            }
        });
    }

    fn fail(self: &Arc<Self>, message: &str) {
        mlog!("{message}");
        self.emit("error", Some(message.to_string()), None);
        self.show_widget();
        self.hide_widget_later(Duration::from_millis(4000));
    }

    /// Load (downloading first, if neither Jarvis nor Murmur has it) and warm up Whisper.
    fn load_model(self: &Arc<Self>) {
        self.set_phase(Phase::Loading);
        let dir = config::data_dir();
        let name = self.cfg().whisper_model;
        let needs_download = !model::model_path(&dir, &name).exists();
        if needs_download {
            self.emit("downloading", Some("Downloading speech model…".into()), Some(0.0));
            self.show_widget();
        }
        let path = model::ensure(&dir, &name, |done, total| {
            let pct = if total > 0 { done as f32 / total as f32 } else { 0.0 };
            self.set_status(&format!("Downloading speech model… {:.0}%", pct * 100.0));
            self.emit("downloading", Some(format!("Downloading model {:.0}%", pct * 100.0)), Some(pct));
        });
        let path = match path {
            Ok(p) => p,
            Err(e) => {
                self.set_phase(Phase::Idle);
                self.set_status("Speech model download failed — choose Reload Settings to retry");
                self.fail(&format!("Download failed: {e}"));
                return;
            }
        };
        self.set_status("Loading speech model…");
        let started = Instant::now();
        match Transcriber::load(&path) {
            Ok(t) => {
                // First inference compiles GPU kernels; do it now instead of on the first question.
                let _ = t.transcribe(&vec![0.0; audio::TARGET_RATE as usize], &self.cfg().language, false, &[]);
                *self.transcriber.lock().unwrap() = Some(Arc::new(t));
                self.set_phase(Phase::Idle);
                mlog!("speech model {} ready in {} ms ({})", name, started.elapsed().as_millis(), path.display());
                self.ready_status();
                if needs_download {
                    self.emit("ready", Some(format!("Ready — hold {}", key_label(&self.cfg().hotkey))), None);
                    self.hide_widget_later(Duration::from_millis(2500));
                }
            }
            Err(e) => {
                self.set_phase(Phase::Idle);
                self.set_status("Speech model failed to load");
                self.fail(&format!("Model load failed: {e}"));
            }
        }
    }

    /// Keeps retrying until the OS grants keyboard-listening permission.
    fn start_hotkey(self: &Arc<Self>) {
        // Presses are handled on a worker thread so the key tap's callback returns immediately;
        // macOS disables taps whose callbacks are slow (starting the mic takes a moment).
        let (tx, rx) = std::sync::mpsc::channel::<HotkeyEvent>();
        let worker = self.clone();
        std::thread::spawn(move || {
            for ev in rx {
                worker.on_hotkey(ev);
            }
        });
        loop {
            let core = self.clone();
            let tx = tx.clone();
            let handler = Box::new(move |ev: HotkeyEvent| match ev {
                // Esc needs an answer (swallow or not), and the check is instant.
                HotkeyEvent::Escape => core.on_hotkey(ev),
                _ => {
                    let _ = tx.send(ev);
                    false
                }
            });
            match hotkey::start(&self.cfg().hotkey, handler) {
                Ok(()) => return,
                Err(e) => {
                    mlog!("hotkey: {e}");
                    self.set_status("Grant Input Monitoring in System Settings → Privacy");
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    }
}

fn system_prompt(cfg: &Config) -> String {
    let now = chrono::Local::now().format("%A, %-d %B %Y, %-I:%M %p");
    let base = cfg.system_prompt.clone().unwrap_or_else(|| {
        format!(
            "You are {name}, a helpful voice assistant running privately on the user's Mac. \
             Everything you write is read aloud by a text-to-speech voice, so answer the way a \
             person would speak: usually one to three short sentences, more only when the user \
             asks for detail or steps. Never use markdown, bullet points, headings, code blocks, \
             tables, emojis or links. Write numbers, times and units the way you would say them. \
             The user's words come from speech recognition and may contain mistakes, so work out \
             what they most likely meant. You have no internet access: if a question needs live \
             information such as news, weather or prices, say so briefly instead of guessing. \
             You can only talk for now: you cannot open apps, control the computer, set reminders \
             or send messages, so never offer to.",
            name = cfg.assistant_name
        )
    });
    format!("{base}\n\nCurrent date and time: {now}.")
}

fn key_label(key: &str) -> &str {
    match key {
        "fn" | "globe" => "Fn",
        "right_command" => "Right ⌘",
        "right_option" => "Right ⌥",
        "right_control" | "right_ctrl" => "Right Ctrl",
        "right_shift" => "Right Shift",
        other => other,
    }
}

/// Bottom-centre of the screen under the mouse.
fn place_widget(app: &AppHandle, win: &WebviewWindow) {
    let Ok(size) = win.outer_size() else { return };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else {
        mlog!("widget: no monitor found to place it on");
        return;
    };
    let area = m.work_area();
    let margin = (20.0 * m.scale_factor()) as i32;
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

mod panel {
    use tauri::{Manager, WebviewWindow};
    use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, StyleMask, WebviewWindowExt};

    tauri_panel! {
        panel!(WidgetPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }

    const STATUS_WINDOW_LEVEL: i64 = 25;

    /// Turns the widget window into a non-activating NSPanel: the only window type that can
    /// float over full-screen apps on every Space without stealing focus.
    pub fn convert(win: &WebviewWindow) -> tauri::Result<()> {
        let panel = win.to_panel::<WidgetPanel>()?;
        panel.set_level(STATUS_WINDOW_LEVEL);
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary()
                .stationary()
                .ignores_cycle()
                .into(),
        );
        if let Err(e) = panel.add_style_mask(StyleMask::empty().nonactivating_panel().value()) {
            mlog!("widget: could not make panel non-activating: {e}");
        }
        panel.set_ignores_mouse_events(true);
        Ok(())
    }

    pub fn show(win: &WebviewWindow) -> bool {
        set_visible(win, true)
    }

    pub fn hide(win: &WebviewWindow) -> bool {
        set_visible(win, false)
    }

    fn set_visible(win: &WebviewWindow, visible: bool) -> bool {
        let app = win.app_handle().clone();
        if app.get_webview_panel(win.label()).is_err() {
            return false;
        }
        let label = win.label().to_string();
        let _ = win.run_on_main_thread(move || {
            if let Ok(panel) = app.get_webview_panel(&label) {
                if visible { panel.show() } else { panel.hide() }
            }
        });
        true
    }
}

/// Shows the widget without it becoming key or stealing focus from the app in front.
fn show_without_focus(win: &WebviewWindow) {
    if !panel::show(win) {
        let _ = win.show();
    }
}

fn hide_widget(win: &WebviewWindow) {
    if !panel::hide(win) {
        let _ = win.hide();
    }
}

/// Opens (or focuses) the main window, optionally on a given tab ("home", "history", "settings").
/// While it is open Jarvis shows a Dock icon so it can be ⌘-Tabbed to like a normal app.
fn open_main_window(app: &AppHandle, tab: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        if let Some(tab) = tab {
            let _ = w.emit("navigate", tab);
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let url = format!("app.html#{}", tab.unwrap_or("home"));
    // Content runs under the traffic lights, like native Mac apps; the page provides drag regions.
    // Translucent window + the system sidebar material = native vibrancy behind the sidebar;
    // the page paints its own opaque background for the content area.
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
        .title("Jarvis")
        .inner_size(1000.0, 700.0)
        .min_inner_size(820.0, 560.0)
        .center()
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .transparent(true)
        .effects(
            tauri::window::EffectsBuilder::new()
                .effect(tauri::window::Effect::Sidebar)
                .state(tauri::window::EffectState::FollowsWindowActiveState)
                .build(),
        )
        .build();
    match built {
        Ok(w) => {
            let handle = app.clone();
            w.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            });
            // Follow the user to their current Space instead of pulling them to this window's.
            if let Ok(ns) = w.ns_window() {
                let ns = ns as usize;
                let _ = w.run_on_main_thread(move || unsafe { move_to_active_space(ns as *mut std::ffi::c_void) });
            }
            let _ = w.set_focus();
        }
        Err(e) => mlog!("could not open main window: {e}"),
    }
}

/// Adds NSWindowCollectionBehaviorMoveToActiveSpace to a window.
unsafe fn move_to_active_space(ns_window: *mut std::ffi::c_void) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    const MOVE_TO_ACTIVE_SPACE: usize = 1 << 1;
    let window = &*(ns_window as *mut AnyObject);
    let current: usize = msg_send![window, collectionBehavior];
    let _: () = msg_send![window, setCollectionBehavior: current | MOVE_TO_ACTIVE_SPACE];
}

/// Opens a file or folder in its default app (Finder for folders).
fn open_path(path: &std::path::Path) -> Result<(), String> {
    let result = std::process::Command::new("open").arg(path).output();
    let error = match result {
        Ok(out) if out.status.success() => return Ok(()),
        Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
        Err(e) => e.to_string(),
    };
    mlog!("could not open {}: {error}", path.display());
    Err(error)
}

/// Opens a file in the default text editor, creating it if needed.
fn open_text_file(path: &std::path::Path) {
    if !path.exists() {
        let _ = std::fs::write(path, "");
    }
    match std::process::Command::new("open").arg("-t").arg(path).output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => mlog!("could not open {}: {}", path.display(), String::from_utf8_lossy(&out.stderr).trim()),
        Err(e) => mlog!("could not open {}: {e}", path.display()),
    }
}

/// Short, quiet macOS system sound ("Tink", "Pop", …). Non-blocking.
fn play_sound(name: &str) {
    let path = format!("/System/Library/Sounds/{name}.aiff");
    let _ = std::process::Command::new("afplay").args(["-v", "0.35", &path]).spawn();
}

/// Lets the widget page write into jarvis.log.
#[tauri::command]
fn widget_log(message: String) {
    mlog!("widget js: {message}");
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_nspanel::init())
        .invoke_handler(tauri::generate_handler![
            widget_log,
            commands::get_state,
            commands::save_config,
            commands::preview_voice,
            commands::stop_speaking,
            commands::ask_text,
            commands::new_conversation,
            commands::history_list,
            commands::history_delete,
            commands::history_clear,
            commands::copy_text,
            commands::set_login,
            commands::open_privacy,
            commands::open_voice_settings,
            commands::open_data_folder,
        ])
        .setup(|app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let first_run = !config::config_path().exists();
            let cfg = config::load();

            use tauri_plugin_autostart::ManagerExt;
            let status = MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Jarvis…", true, Some("CmdOrCtrl+,"))?;
            let history_item = MenuItem::with_id(app, "history", "History…", true, None::<&str>)?;
            let new_chat = MenuItem::with_id(app, "new", "New Conversation", true, Some("CmdOrCtrl+N"))?;
            let log = MenuItem::with_id(app, "log", "Open Log", true, None::<&str>)?;
            let login_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let login_item = CheckMenuItem::with_id(app, "login", "Start at Login", true, login_enabled, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Jarvis", true, Some("CmdOrCtrl+Q"))?;
            let sep = || PredefinedMenuItem::separator(app);
            let menu = Menu::with_items(
                app,
                &[&status, &sep()?, &open_item, &history_item, &new_chat, &sep()?, &log, &login_item, &quit],
            )?;

            TrayIconBuilder::with_id("jarvis")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Jarvis — local voice assistant")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, ev| match ev.id.as_ref() {
                    "quit" => app.exit(0),
                    "new" => app.state::<Arc<Core>>().new_conversation(),
                    "open" => open_main_window(app, Some("home")),
                    "history" => open_main_window(app, Some("history")),
                    "log" => open_text_file(&config::log_path()),
                    "login" => {
                        let autolaunch = app.autolaunch();
                        let enable = !autolaunch.is_enabled().unwrap_or(false);
                        let result = if enable { autolaunch.enable() } else { autolaunch.disable() };
                        if let Err(e) = result {
                            mlog!("start at login: {e}");
                        }
                        let _ = login_item.set_checked(autolaunch.is_enabled().unwrap_or(false));
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(w) = app.get_webview_window("widget") {
                let _ = w.set_ignore_cursor_events(true);
                if let Err(e) = panel::convert(&w) {
                    mlog!("widget: panel conversion failed: {e}");
                }
            }

            let core = Arc::new(Core {
                app: app.handle().clone(),
                ollama: Ollama::new(&cfg.ollama_url, &cfg.llm_model, &cfg.keep_alive),
                speaker: Speaker::new(&cfg.voice, cfg.speech_rate),
                cfg: RwLock::new(cfg),
                recorder: Recorder::new(),
                transcriber: Mutex::new(None),
                conversation: Mutex::new(Conversation::default()),
                phase: Mutex::new(Phase::Loading),
                turn: AtomicU64::new(0),
                gesture: Mutex::new(Gesture::default()),
                in_conversation: AtomicBool::new(false),
                vad: Mutex::new(Vad::new()),
                status_item: status,
                status: Mutex::new("Starting…".into()),
                last_warm_up: Mutex::new(None),
            });

            let trusted = permission::has_accessibility(true);
            let c = core.cfg();
            mlog!("started v{} — accessibility: {trusted}, hotkey: {}, llm: {}", env!("CARGO_PKG_VERSION"), c.hotkey, c.llm_model);
            if !trusted {
                core.set_status("Allow Jarvis in Privacy & Security → Accessibility");
                // Relaunch once permission is granted so the hotkey can be intercepted.
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(2));
                    if permission::has_accessibility(false) {
                        mlog!("accessibility granted, restarting");
                        handle.restart();
                    }
                });
            }

            let c = core.clone();
            std::thread::spawn(move || {
                c.load_model();
                // Load the LLM too, so the first question doesn't wait for it.
                c.warm_up_llm();
            });
            let c = core.clone();
            std::thread::spawn(move || c.start_hotkey());
            app.manage(core);
            // Onboarding: show the app window on first run or while a permission is missing.
            // Debug aid: `open --env JARVIS_TAB=settings Jarvis.app` opens straight onto a page.
            let debug_tab = std::env::var("JARVIS_TAB").ok();
            if first_run || !trusted || debug_tab.is_some() {
                open_main_window(app.handle(), Some(debug_tab.as_deref().unwrap_or("home")));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Jarvis");

    app.run(|app, event| match event {
        // Menu bar app: keep running with no windows open.
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        // Launching Jarvis again (Spotlight, Finder, Dock) opens the app window.
        RunEvent::Reopen { .. } => open_main_window(app, None),
        _ => {}
    });
}

/// Headless check of the brain and voice: `jarvis --ask "what's a good name for a cat?"`.
pub fn cli_ask(question: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let cfg = config::load();
    let ollama = Ollama::new(&cfg.ollama_url, &cfg.llm_model, &cfg.keep_alive);
    let speaker = Speaker::new(&cfg.voice, cfg.speech_rate);
    let messages = vec![Message::system(system_prompt(&cfg)), Message::user(question)];
    let mut splitter = SentenceSplitter::default();
    let started = Instant::now();
    let mut first = None;
    ollama.chat(&messages, |piece| {
        first.get_or_insert(started.elapsed().as_millis());
        print!("{piece}");
        let _ = std::io::stdout().flush();
        if cfg.speak_replies {
            for s in splitter.push(piece) {
                speaker.say(&llm::speakable(&s));
            }
        }
        true
    })?;
    if let Some(rest) = splitter.finish() {
        speaker.say(&llm::speakable(&rest));
    }
    println!();
    eprintln!("model: {}  first words: {} ms  full reply: {} ms", cfg.llm_model, first.unwrap_or_default(), started.elapsed().as_millis());
    speaker.wait(|| true);
    Ok(())
}
