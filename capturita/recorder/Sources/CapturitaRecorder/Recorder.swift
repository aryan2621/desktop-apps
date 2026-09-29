import AppKit
@preconcurrency import ScreenCaptureKit

/// Records a display, an area of a display, or a single window into separate track files:
///   screen.mov (no cursor), system-audio.m4a, microphone.m4a, camera.mov, cursor.json
/// and describes them in project.json, which the editor reads.
@MainActor
final class Recorder: NSObject {
    private let camera: CameraBubble
    private let captureQueue = DispatchQueue(label: "capturita.capture")

    private var stream: SCStream?
    private var clock: RecordingClock?
    private var cursor: CursorTracker?
    private var outputDir: URL?
    private var source: [String: Any] = [:]
    private var createdAt = Date()
    private var screenSize = CGSize.zero
    private var stopping = false
    private var microphone: MicrophoneRecorder?

    // Only touched from captureQueue while the stream runs.
    nonisolated(unsafe) private var screenWriter: TrackWriter?
    nonisolated(unsafe) private var systemAudioWriter: TrackWriter?

    /// Called when the system ends the capture on its own (e.g. the recorded window was closed).
    var onFinishedBySystem: ((Result<[String: Any], Error>) -> Void)?

    init(camera: CameraBubble) {
        self.camera = camera
    }

    var isRecording: Bool { stream != nil }

    /// Seconds recorded so far, excluding pauses (for the control bar's timer).
    var elapsed: Double {
        guard let clock else { return 0 }
        return (clock.endTime() - clock.startedAt).seconds
    }

    func start(_ args: [String: Any]) async throws -> [String: Any] {
        guard stream == nil else { throw RecorderError("A recording is already running") }
        guard CGPreflightScreenCaptureAccess() else { throw RecorderError("Screen recording permission is missing") }
        guard let dirPath = args.string("outputDir") else { throw RecorderError("outputDir is required") }
        let sourceArgs = args.dict("source") ?? [:]
        let fps = Int(args.number("fps") ?? 60)
        let systemAudio = args.bool("systemAudio") ?? true
        let microphoneID = args.string("microphoneId")
        let echoCancellation = args.bool("echoCancellation") ?? true

        // Windows on other Spaces can be recorded too, so look them up among all windows.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let excludedApps = content.applications.filter { Sources.ownProcessIDs.contains($0.processID) }

        let filter: SCContentFilter
        let configuration = SCStreamConfiguration()
        /// The captured area in global points (top-left origin), used to place the cursor.
        let area: CGRect
        var pixelSize: CGSize

        switch sourceArgs.string("type") ?? "display" {
        case "window":
            guard let windowID = sourceArgs.number("windowId").map({ CGWindowID($0) }),
                  let window = content.windows.first(where: { $0.windowID == windowID })
            else { throw RecorderError("That window is no longer available") }
            filter = SCContentFilter(desktopIndependentWindow: window)
            area = window.frame
            pixelSize = CGSize(width: filter.contentRect.width * CGFloat(filter.pointPixelScale),
                               height: filter.contentRect.height * CGFloat(filter.pointPixelScale))
            source = ["type": "window", "name": [window.owningApplication?.applicationName, window.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " — ")]
        default:
            let displayID = sourceArgs.number("displayId").map { CGDirectDisplayID($0) } ?? CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                throw RecorderError("That display is no longer available")
            }
            filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])
            let scale = CGFloat(filter.pointPixelScale)
            let bounds = CGDisplayBounds(displayID)
            if let region = rect(from: sourceArgs.dict("rect")) {
                configuration.sourceRect = region
                area = region.offsetBy(dx: bounds.minX, dy: bounds.minY)
                pixelSize = CGSize(width: region.width * scale, height: region.height * scale)
                source = ["type": "area", "name": Sources.screen(for: displayID)?.localizedName ?? "Display"]
            } else {
                area = bounds
                pixelSize = CGSize(width: CGFloat(display.width) * scale, height: CGFloat(display.height) * scale)
                source = ["type": "display", "name": Sources.screen(for: displayID)?.localizedName ?? "Display"]
            }
        }

        pixelSize = Recorder.encodableSize(pixelSize)
        screenSize = pixelSize
        source["area"] = rectJSON(area)

        configuration.width = Int(pixelSize.width)
        configuration.height = Int(pixelSize.height)
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.showsCursor = false
        configuration.queueDepth = 8
        configuration.capturesAudio = systemAudio
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.excludesCurrentProcessAudio = true

        let dir = URL(fileURLWithPath: dirPath, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Start the microphone before the clock so its warm-up doesn't cut the first words.
        var microphone: MicrophoneRecorder?
        if microphoneID != nil {
            let recorder = MicrophoneRecorder(url: dir.appendingPathComponent("microphone.m4a"))
            do {
                try recorder.start(deviceUID: microphoneID, echoCancellation: echoCancellation)
            } catch {
                recorder.cancel()
                try? FileManager.default.removeItem(at: dir)
                throw RecorderError("Could not start the microphone: \(error.localizedDescription)")
            }
            try? await Task.sleep(for: .milliseconds(echoCancellation ? 1000 : 150))
            microphone = recorder
        }
        let clock = RecordingClock()
        microphone?.clock = clock

        screenWriter = TrackWriter(url: dir.appendingPathComponent("screen.mov"),
                                   kind: .video(width: Int(pixelSize.width), height: Int(pixelSize.height), fps: fps), clock: clock)
        systemAudioWriter = systemAudio ? TrackWriter(url: dir.appendingPathComponent("system-audio.m4a"), kind: .audio, clock: clock) : nil

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
        if systemAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: captureQueue) }

        if camera.isVisible {
            camera.startRecording(to: dir.appendingPathComponent("camera.mov"), clock: clock)
        }
        let cursor = CursorTracker(clock: clock, area: area)

        do {
            try await stream.startCapture()
        } catch {
            microphone?.cancel()
            camera.stopRecording()
            clearWriters()
            try? FileManager.default.removeItem(at: dir)
            throw error
        }
        cursor.start()

        self.stream = stream
        self.microphone = microphone
        self.clock = clock
        self.cursor = cursor
        self.outputDir = dir
        self.createdAt = Date()
        self.stopping = false
        return ["width": Int(pixelSize.width), "height": Int(pixelSize.height)]
    }

    func pause() throws {
        guard let clock else { throw RecorderError("Not recording") }
        clock.pause()
    }

    func resume() throws {
        guard let clock else { throw RecorderError("Not recording") }
        clock.resume()
    }

    func stop() async throws -> [String: Any] {
        guard let stream, let clock, let dir = outputDir, !stopping else { throw RecorderError("Not recording") }
        stopping = true
        let endTime = clock.endTime()
        cursor?.stop()
        try? await stream.stopCapture()
        self.stream = nil

        let screen = screenWriter, systemAudio = systemAudioWriter
        let microphone = self.microphone
        microphone?.stop()
        let cameraWriter = camera.stopRecording()
        async let screenDone = screen?.finish(endTime: endTime) ?? false
        async let systemDone = systemAudio?.finish(endTime: nil) ?? false
        let cameraDone = await camera.onCameraQueue { await cameraWriter?.finish(endTime: endTime) ?? false }
        let (screenOK, systemOK) = await (screenDone, systemDone)
        defer { reset() }

        guard screenOK, let screen, let screenTiming = screen.timing(relativeTo: clock.startedAt) else {
            try? FileManager.default.removeItem(at: dir)
            throw RecorderError(screen?.failed?.localizedDescription ?? "No video frames were captured")
        }

        try cursor?.write(to: dir.appendingPathComponent("cursor.json"))

        func track(_ writer: TrackWriter?, ok: Bool, size: CGSize? = nil) -> Any {
            guard ok, let writer, let timing = writer.timing(relativeTo: clock.startedAt) else {
                if let writer, !writer.hasData { try? FileManager.default.removeItem(at: writer.url) }
                return NSNull()
            }
            var json: [String: Any] = ["file": writer.url.lastPathComponent, "offset": timing.offset, "duration": timing.duration]
            if let size { json["width"] = Int(size.width); json["height"] = Int(size.height) }
            return json
        }

        let project: [String: Any] = [
            "version": 1,
            "id": dir.lastPathComponent,
            "createdAt": ISO8601DateFormatter().string(from: createdAt),
            "source": source,
            "duration": (endTime - clock.startedAt).seconds,
            "tracks": [
                "screen": ["file": screen.url.lastPathComponent, "offset": screenTiming.offset, "duration": screenTiming.duration,
                           "width": Int(screenSize.width), "height": Int(screenSize.height)],
                "systemAudio": track(systemAudio, ok: systemOK),
                "microphone": microphoneTrack(microphone, relativeTo: clock.startedAt),
                "camera": track(cameraWriter, ok: cameraDone, size: camera.dimensions),
                "cursor": ["file": "cursor.json"],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: project, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: dir.appendingPathComponent("project.json"))
        return project.merging(["path": dir.path]) { $1 }
    }

    func cancel() async {
        guard let stream else { return }
        stopping = true
        cursor?.stop()
        try? await stream.stopCapture()
        camera.stopRecording()?.cancel()
        [screenWriter, systemAudioWriter].forEach { $0?.cancel() }
        microphone?.cancel()
        if let outputDir { try? FileManager.default.removeItem(at: outputDir) }
        reset()
    }

    private func reset() {
        stream = nil
        clock = nil
        cursor = nil
        microphone = nil
        outputDir = nil
        stopping = false
        clearWriters()
    }

    private func clearWriters() {
        screenWriter = nil
        systemAudioWriter = nil
    }

    private func microphoneTrack(_ microphone: MicrophoneRecorder?, relativeTo start: CMTime) -> Any {
        guard let microphone else { return NSNull() }
        guard microphone.failed == nil, let timing = microphone.timing(relativeTo: start) else {
            try? FileManager.default.removeItem(at: microphone.url)
            return NSNull()
        }
        return ["file": microphone.url.lastPathComponent, "offset": timing.offset, "duration": timing.duration]
    }

    /// H.264 hardware encoders top out around 4K; scale bigger captures (5K/6K displays) down
    /// and keep dimensions even.
    static func encodableSize(_ size: CGSize) -> CGSize {
        let maxPixels: CGFloat = 3840 * 2160
        let scale = min(1, 4096 / size.width, 4096 / size.height, sqrt(maxPixels / (size.width * size.height)))
        let even = { (value: CGFloat) in CGFloat(Int(value * scale) / 2 * 2) }
        return CGSize(width: even(size.width), height: even(size.height))
    }
}

extension Recorder: SCStreamOutput {
    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .screen:
            // Idle frames (nothing changed on screen) carry no image.
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let rawStatus = attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue: rawStatus) == .complete
            else { return }
            screenWriter?.append(sampleBuffer)
        case .audio:
            systemAudioWriter?.append(sampleBuffer)
        default:
            // The microphone is recorded by MicrophoneRecorder, not the stream.
            break
        }
    }
}

extension Recorder: SCStreamDelegate {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            guard self.stream === stream, !self.stopping else { return }
            IPC.log("stream stopped by the system: \(error.localizedDescription)")
            do {
                self.onFinishedBySystem?(.success(try await self.stop()))
            } catch {
                self.onFinishedBySystem?(.failure(error))
            }
        }
    }
}
