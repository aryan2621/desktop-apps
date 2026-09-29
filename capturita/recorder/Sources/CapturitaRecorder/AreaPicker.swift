import AppKit

/// Full-screen overlay on one display where the user drags out the area to record.
/// Returns the rect in display-local points with a top-left origin (what SCStreamConfiguration.sourceRect expects).
@MainActor
final class AreaPicker {
    private var window: OverlayWindow?
    private var completion: ((CGRect?) -> Void)?

    func pick(on screen: NSScreen, completion: @escaping (CGRect?) -> Void) {
        cancel()
        self.completion = completion

        let window = OverlayWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.level = .screenSaver
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.setFrame(screen.frame, display: true)

        let view = SelectionView(frame: CGRect(origin: .zero, size: screen.frame.size))
        view.onFinish = { [weak self] rect in self?.finish(rect) }
        window.contentView = view

        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        NSCursor.crosshair.push()
        self.window = window
    }

    func cancel() {
        finish(nil)
    }

    private func finish(_ rect: CGRect?) {
        guard let completion else { return }
        self.completion = nil
        NSCursor.pop()
        window?.orderOut(nil)
        window = nil
        completion(rect)
    }
}

private final class OverlayWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

private final class SelectionView: NSView {
    var onFinish: ((CGRect?) -> Void)?
    private var start: CGPoint?
    private var current: CGPoint?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    private var selection: CGRect? {
        guard let start, let current else { return nil }
        return CGRect(x: min(start.x, current.x), y: min(start.y, current.y), width: abs(current.x - start.x), height: abs(current.y - start.y))
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.45).setFill()
        bounds.fill()

        let hint = "Drag to select the area to record · Esc to cancel"
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: NSColor.white]
        let size = hint.size(withAttributes: attributes)
        hint.draw(at: CGPoint(x: bounds.midX - size.width / 2, y: 48), withAttributes: attributes)

        guard let selection, selection.width > 0, selection.height > 0 else { return }
        NSColor.clear.setFill()
        selection.fill(using: .copy)
        NSColor.white.setStroke()
        let border = NSBezierPath(rect: selection)
        border.lineWidth = 2
        border.stroke()

        let label = "\(Int(selection.width)) × \(Int(selection.height))"
        let labelSize = label.size(withAttributes: attributes)
        label.draw(at: CGPoint(x: selection.maxX - labelSize.width, y: selection.maxY + 6), withAttributes: attributes)
    }

    override func mouseDown(with event: NSEvent) {
        start = convert(event.locationInWindow, from: nil)
        current = start
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        current = convert(event.locationInWindow, from: nil)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        current = convert(event.locationInWindow, from: nil)
        if let selection, selection.width >= 40, selection.height >= 40 {
            // Encoders need even pixel sizes; round to whole points.
            onFinish?(selection.integral)
        } else {
            start = nil
            current = nil
            needsDisplay = true
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onFinish?(nil) } // Esc
    }
}
