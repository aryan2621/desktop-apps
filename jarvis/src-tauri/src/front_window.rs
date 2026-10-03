//! Where the user is working: the frontmost app's window on the Spaces currently shown, so the
//! widget appears on that display rather than wherever the mouse happens to be.

/// Frame of the frontmost app's focused window in screen points (top-left origin):
/// `(x, y, width, height)`. Used to show the widget on the display being worked on.
///
/// Accessibility's focused window can sit on another Space or display (Finder on the desktop
/// reports a Finder window from elsewhere, for example), so it is only trusted when it is one
/// of the app's windows actually on screen; otherwise the app's frontmost on-screen window is
/// used, and None (screen under the mouse) when the app has nothing on screen.
pub fn active_window_frame() -> Option<(f64, f64, f64, f64)> {
    use objc2_app_kit::NSWorkspace;

    let front = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let pid = front.processIdentifier();
    let on_screen = onscreen_windows(pid);
    let focused = ax_focused_window_frame(pid);
    let same = |a: &(f64, f64, f64, f64), b: &(f64, f64, f64, f64)| {
        (a.0 - b.0).abs() < 2.0 && (a.1 - b.1).abs() < 2.0 && (a.2 - b.2).abs() < 2.0 && (a.3 - b.3).abs() < 2.0
    };
    match focused {
        Some(f) if on_screen.iter().any(|w| same(w, &f)) => Some(f),
        _ => {
            if focused.is_some() {
                mlog!("widget: focused window {focused:?} is not on screen, using {:?}", on_screen.first());
            }
            on_screen.first().copied()
        }
    }
}

/// Normal-level windows of `pid` on the Spaces currently shown, front to back, in screen points
/// (top-left origin). Needs no permission: only window names are protected.
fn onscreen_windows(pid: i32) -> Vec<(f64, f64, f64, f64)> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
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

    let k_pid = CFString::from_static_string("kCGWindowOwnerPID");
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
            if int(&k_pid) != Some(pid) || int(&k_layer) != Some(0) {
                continue;
            }
            let mut alpha = 1.0f64;
            let a = CFDictionaryGetValue(info, k_alpha.as_CFTypeRef());
            if !a.is_null() {
                CFNumberGetValue(a, NUMBER_FLOAT64, &mut alpha as *mut f64 as *mut c_void);
            }
            let bounds = CFDictionaryGetValue(info, k_bounds.as_CFTypeRef());
            let mut r = CGRect::default();
            if alpha > 0.0
                && !bounds.is_null()
                && CGRectMakeWithDictionaryRepresentation(bounds, &mut r)
                && r.width >= MIN_SIDE
                && r.height >= MIN_SIDE
            {
                windows.push((r.x, r.y, r.width, r.height));
            }
        }
        CFRelease(list);
    }
    windows
}

/// The app's focused (or main) window frame as Accessibility reports it, wherever it is.
fn ax_focused_window_frame(pid: i32) -> Option<(f64, f64, f64, f64)> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    const AX_VALUE_CGPOINT: u32 = 1;
    const AX_VALUE_CGSIZE: u32 = 2;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementCopyAttributeValue(el: *const c_void, attr: CFStringRef, value: *mut *const c_void) -> i32;
        fn AXUIElementSetMessagingTimeout(el: *const c_void, seconds: f32) -> i32;
        fn AXValueGetValue(value: *const c_void, kind: u32, out: *mut c_void) -> bool;
    }

    unsafe fn copy_attr(el: *const c_void, name: &'static str) -> Option<CFType> {
        let mut v: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, CFString::from_static_string(name).as_concrete_TypeRef(), &mut v);
        (err == 0 && !v.is_null()).then(|| CFType::wrap_under_create_rule(v as _))
    }

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
        let (mut p, mut s) = (CGPoint::default(), CGSize::default());
        if !AXValueGetValue(pos.as_CFTypeRef(), AX_VALUE_CGPOINT, &mut p as *mut _ as *mut c_void)
            || !AXValueGetValue(size.as_CFTypeRef(), AX_VALUE_CGSIZE, &mut s as *mut _ as *mut c_void)
            || s.width < 1.0
            || s.height < 1.0
        {
            return None;
        }
        Some((p.x, p.y, s.width, s.height))
    }
}
