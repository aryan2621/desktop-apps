@preconcurrency import AVFoundation
import CoreMedia

/// Shared recording clock. All tracks use host time; paused spans are cut out of every track
/// by shifting later samples back by the total paused duration.
final class RecordingClock {
    private let lock = NSLock()
    private var pausedTotal = CMTime.zero
    private var pauseBegan: CMTime?
    private var resumedAt = CMTime.zero
    let startedAt: CMTime

    init() {
        startedAt = RecordingClock.now()
        resumedAt = startedAt
    }

    static func now() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

    var isPaused: Bool { lock.withLock { pauseBegan != nil } }

    func pause() {
        lock.withLock { if pauseBegan == nil { pauseBegan = RecordingClock.now() } }
    }

    func resume() {
        lock.withLock {
            guard let began = pauseBegan else { return }
            let now = RecordingClock.now()
            pausedTotal = pausedTotal + (now - began)
            resumedAt = now
            pauseBegan = nil
        }
    }

    /// Maps a host timestamp to recording time, or nil if it falls inside a pause.
    func adjust(_ hostTime: CMTime) -> CMTime? {
        lock.withLock {
            if pauseBegan != nil || hostTime < resumedAt { return nil }
            return hostTime - pausedTotal
        }
    }

    /// Seconds since the recording started, excluding pauses.
    func elapsed(at hostTime: CMTime = RecordingClock.now()) -> Double? {
        adjust(hostTime).map { ($0 - startedAt).seconds }
    }

    var offsetForNewSamples: CMTime { lock.withLock { pausedTotal } }

    /// Recording time "now", also valid while paused (then it is the moment the pause began).
    func endTime() -> CMTime {
        lock.withLock { (pauseBegan ?? RecordingClock.now()) - pausedTotal }
    }
}

/// Writes one media track to its own file. Created lazily from the first sample so the
/// audio format (mono/stereo, sample rate) matches what the device actually delivers.
final class TrackWriter {
    enum Kind { case video(width: Int, height: Int, fps: Int), audio }

    let url: URL
    private let kind: Kind
    private let clock: RecordingClock
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private(set) var firstTime: CMTime?
    private(set) var lastTime: CMTime?
    /// End of the last appended sample (its timestamp plus its duration).
    private var endTime: CMTime?
    /// Pixel size the video is written at (known once the first frame arrives).
    private(set) var videoSize: CGSize?
    private(set) var failed: Error?

    init(url: URL, kind: Kind, clock: RecordingClock) {
        self.url = url
        self.kind = kind
        self.clock = clock
    }

    /// Must be called from a single serial queue per writer.
    func append(_ sampleBuffer: CMSampleBuffer, hostTime: CMTime? = nil) {
        guard failed == nil, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let pts = hostTime ?? CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard clock.adjust(pts) != nil else { return }

        let offset = clock.offsetForNewSamples
        let shifted = hostTime != nil ? retime(sampleBuffer, to: pts - offset) : retime(sampleBuffer, by: offset)
        guard let buffer = shifted else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        if let lastTime, time <= lastTime { return }

        do {
            if writer == nil { try start(with: buffer, at: time) }
        } catch {
            failed = error
            IPC.log("could not start writer for \(url.lastPathComponent): \(error)")
            return
        }
        guard let writer, let input, writer.status == .writing else {
            if let writer, writer.status == .failed { failed = writer.error }
            return
        }
        if input.isReadyForMoreMediaData, input.append(buffer) {
            lastTime = time
            let bufferDuration = CMSampleBufferGetDuration(buffer)
            endTime = bufferDuration.isValid ? time + bufferDuration : time
        }
    }

    private func start(with buffer: CMSampleBuffer, at time: CMTime) throws {
        let fileType: AVFileType
        let settings: [String: Any]
        let format = CMSampleBufferGetFormatDescription(buffer)

        switch kind {
        case let .video(maxWidth, maxHeight, fps):
            fileType = .mov
            // The given size is a limit; the shape always comes from the frames themselves. A
            // camera can deliver a different size than its format said before it started
            // (e.g. 1280×720 instead of 640×480), and writing it at the wrong shape squashes it.
            var width = maxWidth
            var height = maxHeight
            if let format {
                let dims = CMVideoFormatDescriptionGetDimensions(format)
                if dims.width > 0, dims.height > 0 {
                    let scale = min(1, Double(maxWidth) / Double(dims.width), Double(maxHeight) / Double(dims.height))
                    width = Int(Double(dims.width) * scale) / 2 * 2
                    height = Int(Double(dims.height) * scale) / 2 * 2
                }
            }
            videoSize = CGSize(width: width, height: height)
            settings = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: max(4_000_000, width * height * 4),
                    AVVideoExpectedSourceFrameRateKey: fps,
                    // A keyframe every second keeps seeking in the editor fast.
                    AVVideoMaxKeyFrameIntervalKey: fps,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ],
            ]
        case .audio:
            fileType = .m4a
            let asbd = format.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
            let channels = min(2, Int(asbd?.mChannelsPerFrame ?? 2))
            settings = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: asbd?.mSampleRate ?? 48_000,
                AVNumberOfChannelsKey: max(1, channels),
                AVEncoderBitRateKey: channels == 1 ? 96_000 : 192_000,
            ]
        }

        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: fileType)
        let input = AVAssetWriterInput(mediaType: kind.isVideo ? .video : .audio, outputSettings: settings, sourceFormatHint: format)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw RecorderError("cannot add input to \(url.lastPathComponent)") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? RecorderError("cannot start \(url.lastPathComponent)") }
        writer.startSession(atSourceTime: time)
        self.writer = writer
        self.input = input
        firstTime = time
    }

    /// Finishes the file. Video tracks are extended to `endTime` because the screen stream
    /// only sends frames when something changes, so a still screen would otherwise be cut short.
    func finish(endTime: CMTime?) async -> Bool {
        guard let writer, let input, writer.status == .writing else { return false }
        input.markAsFinished()
        if kind.isVideo, let endTime, let lastTime, endTime > lastTime {
            writer.endSession(atSourceTime: endTime)
            self.lastTime = endTime
            self.endTime = endTime
        }
        await writer.finishWriting()
        return writer.status == .completed
    }

    func cancel() {
        writer?.cancelWriting()
        try? FileManager.default.removeItem(at: url)
    }

    var hasData: Bool { firstTime != nil }

    /// Track position relative to the start of the recording, in seconds.
    func timing(relativeTo start: CMTime) -> (offset: Double, duration: Double)? {
        guard let firstTime, let end = endTime ?? lastTime else { return nil }
        return ((firstTime - start).seconds, (end - firstTime).seconds)
    }

    private func retime(_ buffer: CMSampleBuffer, by offset: CMTime) -> CMSampleBuffer? {
        if offset == .zero { return buffer }
        return copy(buffer) { $0 - offset }
    }

    private func retime(_ buffer: CMSampleBuffer, to time: CMTime) -> CMSampleBuffer? {
        let original = CMSampleBufferGetPresentationTimeStamp(buffer)
        return copy(buffer) { $0 - original + time }
    }

    private func copy(_ buffer: CMSampleBuffer, transform: (CMTime) -> CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        guard count > 0 else { return nil }
        var timings = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timings, entriesNeededOut: &count)
        for index in timings.indices {
            timings[index].presentationTimeStamp = transform(timings[index].presentationTimeStamp)
            if timings[index].decodeTimeStamp.isValid {
                timings[index].decodeTimeStamp = transform(timings[index].decodeTimeStamp)
            }
        }
        var output: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: buffer, sampleTimingEntryCount: count, sampleTimingArray: &timings, sampleBufferOut: &output)
        return output
    }
}

private extension TrackWriter.Kind {
    var isVideo: Bool {
        if case .video = self { return true }
        return false
    }
}
