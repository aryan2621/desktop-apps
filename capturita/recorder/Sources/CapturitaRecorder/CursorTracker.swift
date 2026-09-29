import AppKit

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

    init(clock: RecordingClock, area: CGRect) {
        self.clock = clock
        self.area = area
    }

    func start() {
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.sample() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer

        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in self?.click(event) }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.click(event)
            return event
        }) {
            monitors.append(local)
        }
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

    private func sample() {
        guard let time = clock.elapsed() else { return }
        let point = currentPoint()
        if point == lastPoint { return }
        lastPoint = point
        moves.append([round3(time), round4(point.x), round4(point.y)])
    }

    private func click(_ event: NSEvent) {
        guard let time = clock.elapsed() else { return }
        let point = currentPoint()
        clicks.append([round3(time), round4(point.x), round4(point.y), event.type == .rightMouseDown ? "right" : "left"])
    }

    private func currentPoint() -> CGPoint {
        // NSEvent uses a bottom-left origin on the primary screen; capture areas use top-left.
        let location = NSEvent.mouseLocation
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let global = CGPoint(x: location.x, y: primaryHeight - location.y)
        return CGPoint(x: (global.x - area.minX) / area.width, y: (global.y - area.minY) / area.height)
    }

    private func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
    private func round4(_ value: Double) -> Double { (value * 10000).rounded() / 10000 }
}
