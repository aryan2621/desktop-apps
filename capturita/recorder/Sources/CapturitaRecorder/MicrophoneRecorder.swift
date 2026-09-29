@preconcurrency import AVFoundation
import CoreAudio

/// Records the microphone with AVAudioEngine so Apple's voice processing can run on it.
/// Voice processing cancels echo: without it the mic also records whatever plays through the
/// speakers, which then sounds doubled next to the system audio track.
final class MicrophoneRecorder {
    let url: URL
    /// Set once the recording clock starts. Voice processing takes about a second to warm up,
    /// so the engine starts first and buffers are ignored until the clock exists.
    var clock: RecordingClock? {
        get { lock.withLock { _clock } }
        set { lock.withLock { _clock = newValue } }
    }
    private var _clock: RecordingClock?
    private var engine = AVAudioEngine()
    /// Whether echo cancellation is actually running (it can fail on some devices).
    private(set) var echoCancellationActive = false
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var sampleRate: Double = 48_000
    private var firstTime: CMTime?
    private var framesWritten: AVAudioFramePosition = 0
    private(set) var failed: Error?

    init(url: URL) {
        self.url = url
    }

    /// Starts with echo cancellation if asked; if the voice-processing unit can't start on this
    /// device, falls back to the plain microphone so the recording still has the voice.
    func start(deviceUID: String?, echoCancellation: Bool) throws {
        // The default input needs no switching, and switching a voice-processing unit fails (-10875).
        let uid = deviceUID == MicrophoneRecorder.defaultInputUID() ? nil : deviceUID
        if echoCancellation {
            do {
                try start(deviceUID: uid, voiceProcessing: true)
                echoCancellationActive = true
                return
            } catch {
                IPC.log("echo cancellation unavailable, recording the plain microphone: \(error)")
                IPC.event("warning", ["message": "Echo cancellation isn't available for this microphone, so it was recorded without it."])
                engine.stop()
                engine = AVAudioEngine()
            }
        }
        try start(deviceUID: uid, voiceProcessing: false)
    }

    private func start(deviceUID: String?, voiceProcessing: Bool) throws {
        let input = engine.inputNode
        // Pick the device before enabling voice processing, which rebuilds the audio unit around it.
        if let deviceUID {
            select(deviceUID: deviceUID, on: input)
        }
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
            // Voice processing normally turns other apps down; keep them at full volume so the
            // screen's own audio isn't quieter in the recording.
            input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }

        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RecorderError("The microphone is not available") }
        sampleRate = format.sampleRate
        let channels = min(Int(format.channelCount), 2)

        try? FileManager.default.removeItem(at: url)
        let file = try AVAudioFile(
            forWriting: url,
            settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: channels == 1 ? 128_000 : 192_000,
            ],
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
        lock.withLock { self.file = file }

        let tapFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: AVAudioChannelCount(channels), interleaved: false)
        input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat) { [weak self] buffer, time in
            self?.write(buffer, at: time)
        }
        engine.prepare()
        try engine.start()
    }

    private func write(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        let hostTime = time.isHostTimeValid ? CMClockMakeHostTimeFromSystemUnits(time.hostTime) : RecordingClock.now()
        // Buffers from before the recording started, or captured while paused, are dropped.
        guard let clock, let adjusted = clock.adjust(hostTime) else { return }
        lock.withLock {
            guard let file, failed == nil else { return }
            do {
                try file.write(from: buffer)
                if firstTime == nil { firstTime = adjusted }
                framesWritten += AVAudioFramePosition(buffer.frameLength)
            } catch {
                failed = error
                IPC.log("microphone write failed: \(error)")
            }
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        // Releasing the AVAudioFile finalizes it.
        lock.withLock { file = nil }
    }

    func cancel() {
        stop()
        try? FileManager.default.removeItem(at: url)
    }

    /// Offset from the recording start and duration, in seconds. The duration comes from the
    /// number of samples written, which is exactly how long the file plays.
    func timing(relativeTo start: CMTime) -> (offset: Double, duration: Double)? {
        lock.withLock {
            guard let firstTime, framesWritten > 0 else { return nil }
            return ((firstTime - start).seconds, Double(framesWritten) / sampleRate)
        }
    }

    static func defaultInputUID() -> String? {
        var deviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr else { return nil }
        var uid: Unmanaged<CFString>?
        var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        address.mSelector = kAudioDevicePropertyDeviceUID
        guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &uidSize, &uid) == noErr, let uid else { return nil }
        return uid.takeRetainedValue() as String
    }

    /// Points the engine's input at a specific device (AVCaptureDevice.uniqueID is the Core Audio UID).
    private func select(deviceUID: String, on input: AVAudioInputNode) {
        var deviceID = AudioDeviceID(0)
        var uid = deviceUID as CFString
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = withUnsafeMutablePointer(to: &uid) { uidPointer in
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                       UInt32(MemoryLayout<CFString>.size), uidPointer, &size, &deviceID)
        }
        guard status == noErr, deviceID != 0, let unit = input.audioUnit else {
            IPC.log("could not find microphone \(deviceUID); using the default input")
            return
        }
        let result = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                          &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size))
        if result != noErr {
            IPC.log("could not switch to microphone \(deviceUID) (\(result)); using the default input")
        }
    }
}
