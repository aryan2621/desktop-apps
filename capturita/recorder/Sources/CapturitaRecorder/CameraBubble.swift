import AppKit
@preconcurrency import AVFoundation

/// Round, draggable, always-on-top webcam preview. While a recording runs, the camera is
/// also written to its own track so the editor can move, resize or hide it later.
/// The bubble window itself is excluded from the screen capture to avoid recording it twice.
@MainActor
final class CameraBubble: NSObject {
    private var session: AVCaptureSession?
    private var panel: NSPanel?
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "capturita.camera")
    private let writerLock = NSLock()
    nonisolated(unsafe) private var writer: TrackWriter?
    nonisolated(unsafe) private var syncClock: CMClock?
    private(set) var dimensions: CGSize = .zero
    var onClose: (() -> Void)?

    var isVisible: Bool { panel != nil }

    func show(deviceID: String?) throws {
        hide()
        guard let device = (deviceID.flatMap { AVCaptureDevice(uniqueID: $0) }) ?? AVCaptureDevice.default(for: .video) else {
            throw RecorderError("No camera found")
        }
        let session = AVCaptureSession()
        session.sessionPreset = .hd1280x720
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw RecorderError("Cannot use this camera") }
        session.addInput(input)
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }

        let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        dimensions = CGSize(width: Int(dims.width), height: Int(dims.height))
        syncClock = session.synchronizationClock

        let size: CGFloat = 180
        let screenFrame = NSScreen.main?.visibleFrame ?? .zero
        let panel = NSPanel(
            contentRect: CGRect(x: screenFrame.minX + 32, y: screenFrame.minY + 32, width: size, height: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        let view = DraggableView(frame: CGRect(x: 0, y: 0, width: size, height: size))
        view.wantsLayer = true
        view.layer?.cornerRadius = size / 2
        view.layer?.masksToBounds = true
        view.layer?.borderWidth = 3
        view.layer?.borderColor = NSColor.white.withAlphaComponent(0.9).cgColor
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        if let connection = preview.connection, connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = true
        }
        view.layer?.addSublayer(preview)
        panel.contentView = view
        panel.orderFrontRegardless()

        queue.async { session.startRunning() }
        self.session = session
        self.panel = panel
    }

    func hide() {
        stopRecording()
        if let session { queue.async { session.stopRunning() } }
        session?.inputs.forEach { session?.removeInput($0) }
        session?.outputs.forEach { session?.removeOutput($0) }
        session = nil
        panel?.orderOut(nil)
        panel = nil
    }

    var windowNumber: Int? { panel?.windowNumber }

    func startRecording(to url: URL, clock: RecordingClock) {
        guard session != nil else { return }
        let width = Int(dimensions.width) / 2 * 2
        let height = Int(dimensions.height) / 2 * 2
        let writer = TrackWriter(url: url, kind: .video(width: width, height: height, fps: 30), clock: clock)
        writerLock.withLock { self.writer = writer }
    }

    @discardableResult
    func stopRecording() -> TrackWriter? {
        writerLock.withLock {
            let writer = self.writer
            self.writer = nil
            return writer
        }
    }

    /// Runs `work` on the camera queue so it cannot race a sample being appended.
    func onCameraQueue<T>(_ work: @escaping () async -> T) async -> T {
        await withCheckedContinuation { continuation in
            queue.async {
                Task { continuation.resume(returning: await work()) }
            }
        }
    }
}

extension CameraBubble: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let writer = writerLock.withLock { self.writer }
        guard let writer else { return }
        // Camera timestamps use the session clock; convert them to host time like the screen stream.
        var hostTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let syncClock {
            hostTime = CMSyncConvertTime(hostTime, from: syncClock, to: CMClockGetHostTimeClock())
        }
        writer.append(sampleBuffer, hostTime: hostTime)
    }
}

private final class DraggableView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
}
