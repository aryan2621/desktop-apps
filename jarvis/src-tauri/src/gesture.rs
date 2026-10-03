//! Timing rules that turn raw hotkey presses into intents: hold for a quick question,
//! tap for a conversation.

use std::time::Duration;

/// Presses shorter than this are taps.
pub const TAP_MAX: Duration = Duration::from_millis(250);
/// The widget appears only once a press has lasted this long, so taps don't flash it.
pub const SHOW_DELAY: Duration = Duration::from_millis(180);

pub fn is_tap(held_for: Duration) -> bool {
    held_for < TAP_MAX
}
