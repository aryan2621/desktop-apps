/** Loudness peaks per bucket of source time, for drawing the audio lane. */
export const WAVEFORM_RATE = 100; // buckets per second

export interface WaveformSource {
    /** Channel data of the decoded track. */
    channels: Float32Array[];
    sampleRate: number;
    /** Source time (s) of the track's first sample. */
    offset: number;
    /** Volume multiplier (0 when muted). */
    gain: number;
}

/**
 * Mixes the tracks into one peak envelope over the recording's duration: each bucket holds the
 * loudest absolute sample of any track in it, scaled by that track's volume and capped at 1.
 */
export function computePeaks(sources: WaveformSource[], duration: number, rate = WAVEFORM_RATE): Float32Array {
    const peaks = new Float32Array(Math.max(1, Math.ceil(duration * rate)));
    for (const { channels, sampleRate, offset, gain } of sources) {
        if (gain <= 0 || channels.length === 0) continue;
        const length = channels[0].length;
        const perBucket = sampleRate / rate;
        for (let bucket = 0; bucket < peaks.length; bucket++) {
            const from = Math.floor((bucket / rate - offset) * sampleRate);
            const to = Math.min(length, Math.floor(from + perBucket));
            if (to <= 0 || from >= length) continue;
            let max = 0;
            for (const data of channels) {
                for (let i = Math.max(0, from); i < to; i++) {
                    const value = Math.abs(data[i]);
                    if (value > max) max = value;
                }
            }
            peaks[bucket] = Math.max(peaks[bucket], Math.min(1, max * gain));
        }
    }
    return peaks;
}

/** The loudest peak between two source times. */
export function peakBetween(peaks: Float32Array, from: number, to: number, rate = WAVEFORM_RATE) {
    const a = Math.max(0, Math.floor(from * rate));
    const b = Math.min(peaks.length, Math.max(a + 1, Math.ceil(to * rate)));
    let max = 0;
    for (let i = a; i < b; i++) if (peaks[i] > max) max = peaks[i];
    return max;
}

/** Combines per-track peaks (computed once at full volume) with the current volumes. */
export function combinePeaks(tracks: { peaks: Float32Array; gain: number }[]): Float32Array | null {
    if (tracks.length === 0) return null;
    const length = Math.max(...tracks.map((t) => t.peaks.length));
    const out = new Float32Array(length);
    for (const { peaks, gain } of tracks) {
        if (gain <= 0) continue;
        for (let i = 0; i < peaks.length; i++) out[i] = Math.max(out[i], Math.min(1, peaks[i] * gain));
    }
    return out;
}
