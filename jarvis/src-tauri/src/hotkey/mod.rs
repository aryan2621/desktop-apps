//! Global hold-to-talk key listener (macOS only for now).

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HotkeyEvent {
    Pressed,
    Released,
    /// Another key was pressed while holding (e.g. ⌥+letter); not a question.
    Cancelled,
    /// Esc was pressed (whether or not the hotkey is held).
    Escape,
}

/// Returns true when the event was consumed (lets the listener swallow Esc while busy).
pub type Handler = Box<dyn Fn(HotkeyEvent) -> bool + Send + 'static>;

mod macos;
pub use macos::start;
