import AppKit
@preconcurrency import AVFoundation

/// Capturita's macOS capture helper. The Tauri app launches it as a sidecar and talks to it
/// over stdin/stdout (see IPC.swift). It runs as an accessory app: no Dock icon, but it can
/// show the area picker and the camera bubble.
@MainActor
final class Controller {
    private let camera = CameraBubble()
    private lazy var recorder = Recorder(camera: camera)
    private let areaPicker = AreaPicker()
    private let bar = ControlBar()
    private var countdownCancelled = false

    init() {
        bar.elapsed = { [unowned self] in recorder.elapsed }
        bar.onCancelCountdown = { [unowned self] in countdownCancelled = true }
        recorder.onFinishedBySystem = { [unowned self] result in
            bar.hide()
            switch result {
            case let .success(project): IPC.event("recordingFinished", project)
            case let .failure(error): IPC.event("recordingFailed", ["message": error.localizedDescription])
            }
        }
    }

    func handle(_ request: [String: Any]) {
        guard let id = request["id"] as? Int, let cmd = request.string("cmd") else {
            IPC.log("ignoring malformed request: \(request)")
            return
        }
        let args = request.dict("args") ?? [:]
        Task {
            do {
                IPC.reply(id, result: try await run(cmd, args))
            } catch {
                IPC.fail(id, error.localizedDescription)
            }
        }
    }

    private func run(_ cmd: String, _ args: [String: Any]) async throws -> Any {
        switch cmd {
        case "ping":
            return "pong"
        case "permissions":
            return Permissions.status()
        case "requestPermission":
            return await Permissions.request(args.string("kind") ?? "")
        case "listSources":
            return try await Sources.list()
        case "thumbnails":
            let ids = { (key: String) in (args[key] as? [NSNumber])?.map(\.intValue) ?? [] }
            return try await Sources.thumbnails(displayIDs: ids("displayIds"), windowIDs: ids("windowIds"))
        case "setAppearance":
            // Keeps the control bar and camera bubble in the app's light/dark theme ("system" follows macOS).
            switch args.string("mode") {
            case "light": NSApp.appearance = NSAppearance(named: .aqua)
            case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
            default: NSApp.appearance = nil
            }
            return NSNull()
        case "pickArea":
            return try await pickArea(displayID: args.number("displayId").map { CGDirectDisplayID($0) } ?? CGMainDisplayID())
        case "showCamera":
            if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
            }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
                throw RecorderError("Camera permission is missing")
            }
            try camera.show(deviceID: args.string("deviceId"))
            return ["visible": true]
        case "hideCamera":
            guard !recorder.isRecording else { throw RecorderError("Stop the recording before turning the camera off") }
            camera.hide()
            return ["visible": false]
        case "start":
            return try await start(args)
        case "cancelCountdown":
            countdownCancelled = true
            return NSNull()
        case "pause":
            try recorder.pause()
            bar.set(.paused)
            return NSNull()
        case "resume":
            try recorder.resume()
            bar.set(.recording)
            return NSNull()
        case "stop":
            bar.set(.saving)
            defer { bar.hide() }
            return try await recorder.stop()
        case "trash":
            // Moves a recording's folder to the Trash, so a delete can be undone from Finder.
            guard let path = args.string("path") else { throw RecorderError("Missing folder") }
            try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)
            return NSNull()
        case "makePreview":
            guard let dir = args.string("dir") else { throw RecorderError("Missing project folder") }
            // Never alongside a recording: both would use the video encoder, and the recording could drop frames.
            while recorder.isRecording {
                try await Task.sleep(for: .seconds(2))
            }
            return try await PreviewMaker.make(projectDir: URL(fileURLWithPath: dir))
        case "cancel":
            bar.hide()
            await recorder.cancel()
            return NSNull()
        default:
            throw RecorderError("Unknown command: \(cmd)")
        }
    }

    /// Shows the floating bar with a countdown, then starts capturing.
    private func start(_ args: [String: Any]) async throws -> Any {
        countdownCancelled = false
        let countdown = Int(args.number("countdown") ?? 3)
        for remaining in stride(from: countdown, to: 0, by: -1) {
            bar.show(.countdown(remaining))
            try? await Task.sleep(for: .seconds(1))
            if countdownCancelled {
                bar.hide()
                throw RecorderError("Cancelled")
            }
        }
        do {
            let result = try await recorder.start(args)
            bar.show(.recording)
            return result
        } catch {
            bar.hide()
            throw error
        }
    }

    private func pickArea(displayID: CGDirectDisplayID) async throws -> Any {
        guard let screen = Sources.screen(for: displayID) else { throw RecorderError("That display is no longer available") }
        let rect: CGRect? = await withCheckedContinuation { continuation in
            areaPicker.pick(on: screen) { continuation.resume(returning: $0) }
        }
        guard let rect else { return ["cancelled": true] }
        return ["cancelled": false, "rect": rectJSON(rect)]
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MainActor.assumeIsolated { Controller() }

Thread {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty,
              let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { continue }
        DispatchQueue.main.async {
            MainActor.assumeIsolated { controller.handle(request) }
        }
    }
    // stdin closed: the app that launched us is gone.
    exit(0)
}.start()

IPC.event("ready", ["version": 1])
app.run()
