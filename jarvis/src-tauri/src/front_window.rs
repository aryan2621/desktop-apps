//! Where the user is working: the topmost window on the Spaces currently shown, so the widget
//! appears on that display rather than wherever the mouse happens to be.

/// Frame of the window the user is working in, in screen points (top-left origin):
/// `(x, y, width, height)`. Used to show the widget on that window.
///
/// This is the topmost normal window on screen, as the window server stacks them. The window
/// server reorders the moment a window is clicked, while "the frontmost app" (NSWorkspace,
/// Accessibility) only catches up once the app has finished activating; pressing the hotkey
/// right after switching windows used to find the previous app and put the widget on its window.
/// Our own windows and system overlays are skipped. None when nothing is on screen (the
/// caller then uses the screen under the mouse).
pub fn active_window_frame() -> Option<(f64, f64, f64, f64)> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct CGRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
        fn CGRectMakeWithDictionaryRepresentation(dict: *const c_void, rect: *mut CGRect) -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(number: *const c_void, kind: isize, out: *mut c_void) -> bool;
        fn CFRelease(cf: *const c_void);
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    const NUMBER_SINT32: isize = 3;
    const NUMBER_FLOAT64: isize = 6;
    /// Skips helper windows (tooltips, status items, invisible trackers).
    const MIN_SIDE: f64 = 50.0;
    /// Our own apps' windows (Murmur, Jarvis, Capturita) never count as where you're working.
    const OURS: [&str; 3] = ["Murmur", "Jarvis", "Capturita"];
    const SYSTEM: [&str; 6] = ["Window Server", "Dock", "Control Center", "Notification Center", "WindowManager", "Screenshot"];

    let me = std::process::id() as i32;
    let k_pid = CFString::from_static_string("kCGWindowOwnerPID");
    let k_owner = CFString::from_static_string("kCGWindowOwnerName");
    let k_layer = CFString::from_static_string("kCGWindowLayer");
    let k_alpha = CFString::from_static_string("kCGWindowAlpha");
    let k_bounds = CFString::from_static_string("kCGWindowBounds");
    unsafe {
        // Front to back.
        let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, 0);
        if list.is_null() {
            return None;
        }
        let mut found = None;
        for i in 0..CFArrayGetCount(list) {
            let info = CFArrayGetValueAtIndex(list, i);
            let int = |key: &CFString| {
                let n = CFDictionaryGetValue(info, key.as_CFTypeRef());
                let mut v = 0i32;
                (!n.is_null() && CFNumberGetValue(n, NUMBER_SINT32, &mut v as *mut i32 as *mut c_void)).then_some(v)
            };
            if int(&k_layer) != Some(0) || int(&k_pid) == Some(me) {
                continue;
            }
            let owner = CFDictionaryGetValue(info, k_owner.as_CFTypeRef());
            let owner = if owner.is_null() { String::new() } else { CFString::wrap_under_get_rule(owner as CFStringRef).to_string() };
            if OURS.contains(&owner.as_str()) || SYSTEM.contains(&owner.as_str()) {
                continue;
            }
            let mut alpha = 1.0f64;
            let a = CFDictionaryGetValue(info, k_alpha.as_CFTypeRef());
            if !a.is_null() {
                CFNumberGetValue(a, NUMBER_FLOAT64, &mut alpha as *mut f64 as *mut c_void);
            }
            let bounds = CFDictionaryGetValue(info, k_bounds.as_CFTypeRef());
            let mut r = CGRect::default();
            if alpha > 0.0 && !bounds.is_null() && CGRectMakeWithDictionaryRepresentation(bounds, &mut r) && r.width >= MIN_SIDE && r.height >= MIN_SIDE {
                found = Some((r.x, r.y, r.width, r.height));
                break;
            }
        }
        CFRelease(list);
        found
    }
}

