/**
 * Changes the speed of audio without changing its pitch, using WSOLA (waveform-similarity
 * overlap-add): overlapping windows are copied from the input at the new rate, and each one
 * is nudged within a small range to where it lines up best with the previous window, so the
 * joins don't click or sound hollow. Playing a buffer faster via playbackRate would instead
 * raise the pitch ("chipmunk" voice).
 */

const WINDOW = 2048; // ~43 ms at 48 kHz, suits speech
const HOP_OUT = WINDOW / 2;
const TOLERANCE = 512; // how far each window may move to find a good join
const DECIMATE = 4; // the alignment search runs on a 4× smaller copy, for speed

export function timeStretch(context: BaseAudioContext, input: AudioBuffer, from: number, to: number, speed: number): AudioBuffer {
    const rate = input.sampleRate;
    const first = Math.max(0, Math.floor(from * rate));
    const last = Math.min(input.length, Math.ceil(to * rate));
    const length = last - first;
    const outLength = Math.max(1, Math.ceil(length / speed));
    const output = context.createBuffer(input.numberOfChannels, outLength, rate);
    if (length < WINDOW * 2) {
        // Too short to stretch meaningfully: resample by dropping/repeating samples.
        for (let c = 0; c < input.numberOfChannels; c++) {
            const source = input.getChannelData(c);
            const target = output.getChannelData(c);
            for (let i = 0; i < outLength; i++) target[i] = source[first + Math.min(length - 1, Math.floor(i * speed))] ?? 0;
        }
        return output;
    }

    const channels = Array.from({ length: input.numberOfChannels }, (_, c) => input.getChannelData(c).subarray(first, last));
    const guide = decimatedMono(channels, DECIMATE);
    const window = hann(WINDOW);
    const hopIn = HOP_OUT * speed;
    const sums = channels.map(() => new Float32Array(outLength + WINDOW));
    const weight = new Float32Array(outLength + WINDOW);

    let previous = 0;
    for (let k = 0; ; k++) {
        const outPos = k * HOP_OUT;
        const nominal = Math.round(k * hopIn);
        if (outPos >= outLength || nominal + WINDOW >= length) break;
        const position = k === 0 ? 0 : bestMatch(guide, previous + HOP_OUT, nominal, length - WINDOW);
        for (let c = 0; c < channels.length; c++) {
            const source = channels[c];
            const sum = sums[c];
            for (let i = 0; i < WINDOW; i++) sum[outPos + i] += source[position + i] * window[i];
        }
        for (let i = 0; i < WINDOW; i++) weight[outPos + i] += window[i];
        previous = position;
    }

    for (let c = 0; c < channels.length; c++) {
        const target = output.getChannelData(c);
        const sum = sums[c];
        for (let i = 0; i < outLength; i++) target[i] = weight[i] > 1e-3 ? sum[i] / weight[i] : 0;
    }
    return output;
}

/**
 * Finds the input position near `nominal` whose start looks most like the audio that
 * naturally follows the previous window (`target`), by cross-correlation.
 */
function bestMatch(guide: Float32Array, target: number, nominal: number, maxPosition: number) {
    const overlap = HOP_OUT / DECIMATE;
    const t = Math.round(target / DECIMATE);
    const low = Math.max(0, Math.round((nominal - TOLERANCE) / DECIMATE));
    const high = Math.min(Math.floor(maxPosition / DECIMATE), Math.round((nominal + TOLERANCE) / DECIMATE));
    if (t + overlap >= guide.length) return Math.min(maxPosition, Math.max(0, nominal));
    let best = Math.round(nominal / DECIMATE);
    let bestScore = -Infinity;
    for (let p = low; p <= high; p++) {
        if (p + overlap >= guide.length) break;
        let score = 0;
        for (let i = 0; i < overlap; i++) score += guide[p + i] * guide[t + i];
        if (score > bestScore) {
            bestScore = score;
            best = p;
        }
    }
    return Math.min(maxPosition, Math.max(0, best * DECIMATE));
}

function decimatedMono(channels: Float32Array[], factor: number) {
    const length = Math.floor(channels[0].length / factor);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        let sum = 0;
        for (const channel of channels) for (let j = 0; j < factor; j++) sum += channel[i * factor + j];
        out[i] = sum / (factor * channels.length);
    }
    return out;
}

function hann(size: number) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    return w;
}
