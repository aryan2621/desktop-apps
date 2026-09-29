import AppKit
@preconcurrency import AVFoundation
@preconcurrency import ScreenCaptureKit

enum Sources {
    /// Processes whose windows never appear in a recording: this helper and the Capturita app that launched it.
    static var ownProcessIDs: Set<pid_t> { [getpid(), getppid()] }

    static func list() async throws -> [String: Any] {
        // Include windows on other Spaces and full-screen apps, not just the current Space.
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)

        let displays: [[String: Any]] = content.displays.map { display in
            [
                "id": Int(display.displayID),
                "name": screen(for: display.displayID)?.localizedName ?? "Display \(display.displayID)",
                "width": display.width,
                "height": display.height,
                "isMain": CGDisplayIsMain(display.displayID) != 0,
            ]
        }

        let windows: [[String: Any]] = content.windows
            .filter { window in
                guard let app = window.owningApplication else { return false }
                let title = window.title ?? ""
                return window.windowLayer == 0
                    && window.frame.width >= 120 && window.frame.height >= 80
                    && !ownProcessIDs.contains(app.processID)
                    && !app.applicationName.isEmpty
                    && !hiddenApps.contains(app.bundleIdentifier)
                    // Off-screen windows without a title are mostly hidden helper windows.
                    && (window.isOnScreen || !title.isEmpty)
            }
            .sorted { a, b in
                if a.isOnScreen != b.isOnScreen { return a.isOnScreen }
                return (a.owningApplication?.applicationName ?? "").localizedCaseInsensitiveCompare(b.owningApplication?.applicationName ?? "") == .orderedAscending
            }
            .map { window in
                [
                    "id": Int(window.windowID),
                    "title": window.title ?? "",
                    "app": window.owningApplication?.applicationName ?? "",
                    "width": Int(window.frame.width),
                    "height": Int(window.frame.height),
                    "isOnScreen": window.isOnScreen,
                    "icon": window.owningApplication.flatMap { appIcon($0.processID) } ?? NSNull(),
                ]
            }

        return [
            "displays": displays,
            "windows": windows,
            "microphones": devices(.audio).map { ["id": $0.uniqueID, "name": $0.localizedName] },
            "cameras": devices(.video).map { ["id": $0.uniqueID, "name": $0.localizedName] },
        ]
    }

    /// Small preview images of displays and windows for the source picker, as data URLs keyed by id.
    static func thumbnails(displayIDs: [Int], windowIDs: [Int]) async throws -> [String: Any] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let excluded = content.applications.filter { ownProcessIDs.contains($0.processID) }
        let displays = content.displays.filter { displayIDs.contains(Int($0.displayID)) }
        let windows = content.windows.filter { windowIDs.contains(Int($0.windowID)) }

        var result: [String: [String: String]] = ["displays": [:], "windows": [:]]
        await withTaskGroup(of: (String, String, String?).self) { group in
            for display in displays {
                let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
                let size = thumbnailSize(width: CGFloat(display.width), height: CGFloat(display.height), maxWidth: 480)
                group.addTask { ("displays", String(display.displayID), await capture(filter, size: size)) }
            }
            for window in windows {
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let size = thumbnailSize(width: window.frame.width, height: window.frame.height, maxWidth: 360)
                group.addTask { ("windows", String(window.windowID), await capture(filter, size: size)) }
            }
            for await (kind, id, image) in group {
                if let image { result[kind]?[id] = image }
            }
        }
        return result
    }

    private static func thumbnailSize(width: CGFloat, height: CGFloat, maxWidth: CGFloat) -> CGSize {
        let scale = min(1, maxWidth / max(1, width))
        return CGSize(width: max(2, (width * scale).rounded()), height: max(2, (height * scale).rounded()))
    }

    private static func capture(_ filter: SCContentFilter, size: CGSize) async -> String? {
        let configuration = SCStreamConfiguration()
        configuration.width = Int(size.width)
        configuration.height = Int(size.height)
        configuration.showsCursor = false
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }

    private static var iconCache: [pid_t: String] = [:]

    /// The owning app's icon as a small PNG data URL.
    private static func appIcon(_ pid: pid_t) -> String? {
        if let cached = iconCache[pid] { return cached }
        guard let icon = NSRunningApplication(processIdentifier: pid)?.icon,
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4,
                                            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        icon.draw(in: NSRect(x: 0, y: 0, width: 64, height: 64))
        NSGraphicsContext.restoreGraphicsState()
        guard let data = bitmap.representation(using: .png, properties: [:]) else { return nil }
        let url = "data:image/png;base64," + data.base64EncodedString()
        iconCache[pid] = url
        return url
    }

    /// System apps whose windows are never useful to record on their own.
    private static let hiddenApps: Set<String> = [
        "com.apple.dock", "com.apple.WindowManager", "com.apple.controlcenter", "com.apple.notificationcenterui",
        "com.apple.Spotlight", "com.apple.wallpaper.agent", "com.apple.systemuiserver", "com.apple.TextInputMenuAgent",
    ]

    static func devices(_ mediaType: AVMediaType) -> [AVCaptureDevice] {
        let types: [AVCaptureDevice.DeviceType] = mediaType == .audio
            ? [.microphone, .external]
            : [.builtInWideAngleCamera, .external, .continuityCamera]
        return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: mediaType, position: .unspecified).devices
    }

    static func screen(for displayID: CGDirectDisplayID) -> NSScreen? {
        NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID }
    }
}
