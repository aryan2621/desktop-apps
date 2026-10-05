import AppKit
import CoreMedia

/// Records the cursor separately from the video (the capture itself hides the cursor),
/// so the editor can draw a smooth cursor, highlight clicks and zoom in on them.
/// Mouse position and clicks can be observed globally without Accessibility permission.
final class CursorTracker {
    private let clock: RecordingClock
    /// Captured area in global top-left-origin points.
    private let area: CGRect
    private var timer: Timer?
    private var monitors: [Any] = []
    private var moves: [[Double]] = []
    private var clicks: [[Any]] = []
    private var lastPoint: CGPoint?
    private var lastTime: Double = -1

    init(clock: RecordingClock, area: CGRect) {
        self.clock = clock
        self.area = area
    }

    func start() {
        // Mouse events give exact timing for every movement; the timer is a fallback for
        // anything they miss (e.g. the cursor moved by another app).
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in self?.sample(at: RecordingClock.now()) }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer

        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in self?.handle(event) }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.handle(event)
            return event
        }) {
            monitors.append(local)
        }
    }

    private func handle(_ event: NSEvent) {
        let time = hostTime(of: event)
        switch event.type {
        case .leftMouseDown, .rightMouseDown: click(event, at: time)
        default: sample(at: time)
        }
    }

    /// When the event happened, on the recording clock. Event timestamps count from system
    /// start-up like `systemUptime`, so their age is the difference.
    private func hostTime(of event: NSEvent) -> CMTime {
        let age = max(0, ProcessInfo.processInfo.systemUptime - event.timestamp)
        return RecordingClock.now() - CMTime(seconds: age, preferredTimescale: 1_000_000_000)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
    }

    func write(to url: URL) throws {
        let json: [String: Any] = [
            "version": 1,
            // Positions are normalized to the captured area: 0,0 is top-left, 1,1 is bottom-right.
            "moves": moves,
            "clicks": clicks,
        ]
        try JSONSerialization.data(withJSONObject: json).write(to: url)
    }

    private func sample(at hostTime: CMTime) {
        guard let time = clock.elapsed(at: hostTime), time > lastTime else { return }
        let point = currentPoint()
        if point == lastPoint { return }
        // After a pause, mark where the cursor rested until just before it moved again, so the
        // editor doesn't glide across the whole pause.
        if let rest = lastPoint, time - lastTime > 2.0 / 60.0 {
            moves.append([round(time - 1.0 / 120.0, 3), round(rest.x, 5), round(rest.y, 5)])
        }
        lastPoint = point
        lastTime = time
        moves.append([round(time, 3), round(point.x, 5), round(point.y, 5)])
    }

    private func click(_ event: NSEvent, at hostTime: CMTime) {
        guard let time = clock.elapsed(at: hostTime) else { return }
        let point = currentPoint()
        clicks.append([round(time, 3), round(point.x, 5), round(point.y, 5), event.type == .rightMouseDown ? "right" : "left"])
    }

    private func currentPoint() -> CGPoint {
        // NSEvent uses a bottom-left origin on the primary screen; capture areas use top-left.
        let location = NSEvent.mouseLocation
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let global = CGPoint(x: location.x, y: primaryHeight - location.y)
        return CGPoint(x: (global.x - area.minX) / area.width, y: (global.y - area.minY) / area.height)
    }

    private func round(_ value: Double, _ digits: Int) -> Double {
        let scale = pow(10.0, Double(digits))
        return (value * scale).rounded() / scale
    }
}
