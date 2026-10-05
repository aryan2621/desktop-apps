@preconcurrency import AVFoundation

/// Makes `screen-preview.mp4`: a 1080p copy of the screen recording for the editor to play.
/// Full-size Retina recordings of busy content (a playing video) can be too heavy for the
/// editor's web view to decode in real time; the copy plays smoothly, and exports still read the
/// original. Uses the hardware encoder, so it takes a fraction of the recording's length.
enum PreviewMaker {
    static let fileName = "screen-preview.mp4"

    static func make(projectDir: URL) async throws -> String {
        let input = projectDir.appendingPathComponent("screen.mov")
        let output = projectDir.appendingPathComponent(fileName)
        if FileManager.default.fileExists(atPath: output.path) { return fileName }
        guard FileManager.default.fileExists(atPath: input.path) else { throw RecorderError("This recording has no screen video") }
        let partial = projectDir.appendingPathComponent("screen-preview.part.mp4")
        try? FileManager.default.removeItem(at: partial)
        let asset = AVURLAsset(url: input)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1920x1080) else {
            throw RecorderError("Could not prepare the preview")
        }
        session.shouldOptimizeForNetworkUse = true
        try await session.export(to: partial, as: .mp4)
        try FileManager.default.moveItem(at: partial, to: output)
        return fileName
    }
}
