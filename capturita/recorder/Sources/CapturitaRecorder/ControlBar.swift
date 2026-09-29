import AppKit

/// Floating recording controls: countdown, timer, pause/resume, stop and discard.
/// A non-activating panel from this accessory helper can float above every Space and
/// full-screen app (a regular app window can't), and like the camera bubble it's excluded
/// from the capture. Button presses are sent to the app as `barAction` events.
@MainActor
final class ControlBar {
    enum Mode { case countdown(Int), recording, paused, saving }

    private var panel: NSPanel?
    private var timer: Timer?
    private let dot = NSView()
    private let label = NSTextField(labelWithString: "")
    private let pauseButton = NSButton()
    private let discardButton = NSButton()
    private let stopButton = NSButton()
    private var mode: Mode = .recording
    /// Seconds recorded so far, excluding pauses.
    var elapsed: () -> Double = { 0 }
    var onCancelCountdown: (() -> Void)?

    func show(_ mode: Mode) {
        if panel == nil { build() }
        set(mode)
        panel?.orderFrontRegardless()
    }

    func set(_ mode: Mode) {
        self.mode = mode
        let recording: Bool
        switch mode {
        case let .countdown(seconds):
            label.stringValue = "Starting in \(seconds)…"
            recording = false
        case .recording, .paused:
            label.stringValue = format(elapsed())
            recording = true
        case .saving:
            label.stringValue = "Saving…"
            recording = false
        }
        let paused = if case .paused = mode { true } else { false }
        dot.layer?.backgroundColor = (paused ? NSColor.systemYellow : NSColor.systemRed).cgColor
        // The dot pulses while recording and holds still when paused.
        if case .recording = mode {
            if dot.layer?.animation(forKey: "pulse") == nil {
                let pulse = CABasicAnimation(keyPath: "opacity")
                pulse.fromValue = 1
                pulse.toValue = 0.35
                pulse.duration = 0.8
                pulse.autoreverses = true
                pulse.repeatCount = .infinity
                dot.layer?.add(pulse, forKey: "pulse")
            }
        } else {
            dot.layer?.removeAnimation(forKey: "pulse")
        }
        pauseButton.isHidden = !recording
        stopButton.isHidden = !recording
        discardButton.isHidden = { if case .saving = mode { return true } else { return false } }()
        discardButton.toolTip = recording ? "Discard recording" : "Cancel"
        setSymbol(pauseButton, paused ? "play.fill" : "pause.fill", paused ? "Resume" : "Pause")
    }

    func hide() {
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
        panel = nil
    }

    private func build() {
        let size = NSSize(width: 250, height: 44)
        let screen = NSScreen.main?.visibleFrame ?? .zero
        let panel = NSPanel(
            contentRect: NSRect(x: screen.midX - size.width / 2, y: screen.maxY - size.height - 12, width: size.width, height: size.height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

        let background = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        background.material = .hudWindow
        background.blendingMode = .behindWindow
        background.state = .active
        // No fixed appearance: the bar follows the system's light or dark mode.
        background.wantsLayer = true
        background.layer?.cornerRadius = size.height / 2
        background.layer?.masksToBounds = true

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 5
        dot.translatesAutoresizingMaskIntoConstraints = false

        label.font = .monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
        label.textColor = .labelColor
        label.translatesAutoresizingMaskIntoConstraints = false

        configure(pauseButton, action: "pause")
        configure(discardButton, action: "discard")
        setSymbol(discardButton, "trash", "Discard recording")
        configure(stopButton, action: "stop")
        setSymbol(stopButton, "stop.fill", "Stop and save (⌘⇧R)")
        stopButton.contentTintColor = .systemRed

        let buttons = NSStackView(views: [pauseButton, discardButton, stopButton])
        buttons.spacing = 4
        buttons.translatesAutoresizingMaskIntoConstraints = false

        [dot, label, buttons].forEach(background.addSubview)
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 10),
            dot.heightAnchor.constraint(equalToConstant: 10),
            dot.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 16),
            dot.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            label.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            buttons.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -10),
            buttons.centerYAnchor.constraint(equalTo: background.centerYAnchor),
        ])
        panel.contentView = background
        self.panel = panel

        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch self.mode {
                case .recording, .paused: self.label.stringValue = self.format(self.elapsed())
                default: break
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func configure(_ button: NSButton, action: String) {
        button.bezelStyle = .regularSquare
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.contentTintColor = .labelColor
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 30).isActive = true
        button.heightAnchor.constraint(equalToConstant: 30).isActive = true
        button.target = self
        button.action = #selector(pressed(_:))
        button.identifier = NSUserInterfaceItemIdentifier(action)
    }

    private func setSymbol(_ button: NSButton, _ name: String, _ tooltip: String) {
        let configuration = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        button.image = NSImage(systemSymbolName: name, accessibilityDescription: tooltip)?.withSymbolConfiguration(configuration)
        button.toolTip = tooltip
    }

    @objc private func pressed(_ sender: NSButton) {
        guard var action = sender.identifier?.rawValue else { return }
        switch (action, mode) {
        case ("discard", .countdown):
            onCancelCountdown?()
            return
        case ("pause", .paused):
            action = "resume"
        default:
            break
        }
        IPC.event("barAction", ["action": action])
    }

    private func format(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        return total >= 3600
            ? String(format: "%d:%02d:%02d", total / 3600, total % 3600 / 60, total % 60)
            : String(format: "%d:%02d", total / 60, total % 60)
    }
}
