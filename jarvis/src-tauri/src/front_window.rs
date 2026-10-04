//! Where the user is working, for placing the widget and acting on "the app in front".
// Where the user is working, read live every time.
//
// Two macOS shortcuts look right but aren't:
// - NSWorkspace's frontmostApplication is a cached value kept current by activation
//   notifications delivered to a thread's run loop. Read from our hotkey and worker threads,
//   which run none, it can lag or stay stuck on an app the user already left until relaunch.
// - The first normal-level window in the window server's list isn't always the app's main
//   window: full-screen browsers and Electron apps stack toolbar strips above the page as
//   separate windows.
// So: the app with keyboard focus comes from Accessibility (a live query to that app; the same
// source screen readers use), and its focused window is checked against the windows actually on
// screen by overlap, not exact size (a full-screen window reports the whole screen while its
// pieces don't). Without Accessibility, the owner of the topmost window, and its largest window.

/// A frame in screen points, top-left origin: (x, y, width, height).
pub type Frame = (f64, f64, f64, f64);

/// A normal window on the Spaces currently shown.
struct OnScreen {
    pid: i32,
    owner: String,
    frame: Frame,
}

/// Normal-level windows on the Spaces currently shown, front to back, leaving out ours, the
/// system's, invisible ones and tiny helpers. Needs no permission (only window titles are
/// protected).
fn onscreen_windows() -> Vec<OnScreen> {
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
    const MIN_SIDE: f64 = 50.0;
    const OURS: [&str; 3] = ["Murmur", "Jarvis", "Capturita"];
    const SYSTEM: [&str; 6] = ["Window Server", "Dock", "Control Center", "Notification Center", "WindowManager", "Screenshot"];

    let me = std::process::id() as i32;
    let k_pid = CFString::from_static_string("kCGWindowOwnerPID");
    let k_owner = CFString::from_static_string("kCGWindowOwnerName");
    let k_layer = CFString::from_static_string("kCGWindowLayer");
    let k_alpha = CFString::from_static_string("kCGWindowAlpha");
    let k_bounds = CFString::from_static_string("kCGWindowBounds");
    let mut windows = Vec::new();
    unsafe {
        let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, 0);
        if list.is_null() {
            return windows;
        }
        for i in 0..CFArrayGetCount(list) {
            let info = CFArrayGetValueAtIndex(list, i);
            let int = |key: &CFString| {
                let n = CFDictionaryGetValue(info, key.as_CFTypeRef());
                let mut v = 0i32;
                (!n.is_null() && CFNumberGetValue(n, NUMBER_SINT32, &mut v as *mut i32 as *mut c_void)).then_some(v)
            };
            let (Some(pid), Some(0)) = (int(&k_pid), int(&k_layer)) else { continue };
            if pid == me {
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
                windows.push(OnScreen { pid, owner, frame: (r.x, r.y, r.width, r.height) });
            }
        }
        CFRelease(list);
    }
    windows
}

mod ax {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> *const c_void;
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(el: *const c_void, attr: CFStringRef, value: *mut *const c_void) -> i32;
        fn AXUIElementSetMessagingTimeout(el: *const c_void, seconds: f32) -> i32;
        fn AXUIElementGetPid(el: *const c_void, pid: *mut i32) -> i32;
        fn AXValueGetValue(value: *const c_void, kind: u32, out: *mut c_void) -> bool;
    }

    unsafe fn copy_attr(el: *const c_void, name: &'static str) -> Option<CFType> {
        let mut v: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, CFString::from_static_string(name).as_concrete_TypeRef(), &mut v);
        (err == 0 && !v.is_null()).then(|| CFType::wrap_under_create_rule(v as _))
    }

    /// The process with keyboard focus, asked of Accessibility now (not a cached value).
    pub fn focused_pid() -> Option<i32> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let _system = CFType::wrap_under_create_rule(system as _);
            AXUIElementSetMessagingTimeout(system, 0.25);
            let app = copy_attr(system, "AXFocusedApplication")?;
            let mut pid = 0;
            (AXUIElementGetPid(app.as_CFTypeRef(), &mut pid) == 0 && pid > 0).then_some(pid)
        }
    }

    /// The app's focused (else main) window frame, wherever it is.
    pub fn focused_window(pid: i32) -> Option<super::Frame> {
        #[repr(C)]
        #[derive(Default)]
        struct Pair(f64, f64);
        const AX_VALUE_CGPOINT: u32 = 1;
        const AX_VALUE_CGSIZE: u32 = 2;
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return None;
            }
            let _app = CFType::wrap_under_create_rule(app as _);
            AXUIElementSetMessagingTimeout(app, 0.25);
            let window = copy_attr(app, "AXFocusedWindow").or_else(|| copy_attr(app, "AXMainWindow"))?;
            let pos = copy_attr(window.as_CFTypeRef(), "AXPosition")?;
            let size = copy_attr(window.as_CFTypeRef(), "AXSize")?;
            let (mut p, mut s) = (Pair::default(), Pair::default());
            let ok = AXValueGetValue(pos.as_CFTypeRef(), AX_VALUE_CGPOINT, &mut p as *mut _ as *mut c_void)
                && AXValueGetValue(size.as_CFTypeRef(), AX_VALUE_CGSIZE, &mut s as *mut _ as *mut c_void);
            (ok && s.0 >= 1.0 && s.1 >= 1.0).then_some((p.0, p.1, s.0, s.1))
        }
    }
}

/// The process the user is working in: the app with keyboard focus, else the owner of the
/// topmost window.
pub fn active_pid() -> Option<i32> {
    ax::focused_pid().filter(|&pid| pid != std::process::id() as i32).or_else(|| onscreen_windows().first().map(|w| w.pid))
}

fn area(f: &Frame) -> f64 {
    f.2 * f.3
}

fn overlap(a: &Frame, b: &Frame) -> f64 {
    let w = (a.0 + a.2).min(b.0 + b.2) - a.0.max(b.0);
    let h = (a.1 + a.3).min(b.1 + b.3) - a.1.max(b.1);
    if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
}

/// The window the user is working in, on screen now; None when it can't be told (the caller
/// then uses the screen under the mouse).
pub fn active_window_frame() -> Option<Frame> {
    let windows = onscreen_windows();
    let focused = ax::focused_pid().filter(|&pid| pid != std::process::id() as i32);
    // The focused app, else (no Accessibility answer) the owner of the topmost window.
    let pid = focused.or_else(|| windows.first().map(|w| w.pid))?;
    let mine: Vec<&OnScreen> = windows.iter().filter(|w| w.pid == pid).collect();
    let Some(largest) = mine.iter().max_by(|a, b| area(&a.frame).total_cmp(&area(&b.frame))) else {
        // The focused app has nothing on screen here (e.g. Finder with only the desktop).
        mlog!("widget: the app in front (pid {pid}) has no window on screen; using the screen under the mouse");
        return None;
    };
    // Its focused window, when that is on this Space: mostly covered by its windows here.
    if let Some(f) = ax::focused_window(pid) {
        let covered: f64 = mine.iter().map(|w| overlap(&w.frame, &f)).sum();
        if covered >= 0.5 * area(&f) {
            mlog!("widget: on {}'s focused window {f:?}", largest.owner);
            return Some(f);
        }
        mlog!("widget: {}'s focused window {f:?} is elsewhere; using its largest window {:?}", largest.owner, largest.frame);
    } else {
        mlog!("widget: on {}'s largest window {:?}", largest.owner, largest.frame);
    }
    Some(largest.frame)
}
