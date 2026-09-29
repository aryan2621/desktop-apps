@preconcurrency import AVFoundation
import CoreGraphics

enum Permissions {
    static func status() -> [String: String] {
        [
            "screen": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
            "microphone": describe(AVCaptureDevice.authorizationStatus(for: .audio)),
            "camera": describe(AVCaptureDevice.authorizationStatus(for: .video)),
        ]
    }

    /// Screen recording has no async prompt: macOS shows its dialog (once) and the user
    /// has to toggle the app in System Settings, then restart it.
    static func request(_ kind: String) async -> [String: String] {
        switch kind {
        case "screen":
            _ = CGRequestScreenCaptureAccess()
        case "microphone":
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        case "camera":
            _ = await AVCaptureDevice.requestAccess(for: .video)
        default:
            break
        }
        return status()
    }

    private static func describe(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .notDetermined: return "notDetermined"
        default: return "denied"
        }
    }
}
