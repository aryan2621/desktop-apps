//! Accessibility permission, needed so the hotkey can be intercepted instead of only watched.

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use std::ffi::c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

/// With `prompt`, macOS shows its "allow in Accessibility settings" dialog if not yet trusted.
pub fn has_accessibility(prompt: bool) -> bool {
    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let value = if prompt { CFBoolean::true_value() } else { CFBoolean::false_value() };
    let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const c_void) }
}
