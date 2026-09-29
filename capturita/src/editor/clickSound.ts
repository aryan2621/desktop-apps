/**
 * A short mouse-click "tick", synthesized so no recorded sound file is needed: a burst of
 * noise for the snap plus two quickly decaying tones for the body of the click.
 */
export function createClickSound(context: BaseAudioContext): AudioBuffer {
    const rate = context.sampleRate;
    const length = Math.round(rate * 0.04);
    const buffer = context.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    // Fixed seed so the click sounds identical every time (and in export).
    let seed = 12345;
    const noise = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x3fffffff - 1;
    };
    let peak = 0;
    for (let i = 0; i < length; i++) {
        const t = i / rate;
        const snap = noise() * Math.exp(-t / 0.0015);
        const high = Math.sin(2 * Math.PI * 3400 * t) * Math.exp(-t / 0.004) * 0.6;
        const body = Math.sin(2 * Math.PI * 1100 * t) * Math.exp(-t / 0.009) * 0.4;
        data[i] = snap + high + body;
        peak = Math.max(peak, Math.abs(data[i]));
    }
    for (let i = 0; i < length; i++) data[i] = (data[i] / peak) * 0.8;
    return buffer;
}

/**
 * A two-part mechanical mouse click, synthesized like the tick: a sharp "press" with a short
 * plastic resonance, then a lighter, higher "release" about 70 ms later.
 */
export function createMouseClickSound(context: BaseAudioContext): AudioBuffer {
    const rate = context.sampleRate;
    const length = Math.round(rate * 0.13);
    const buffer = context.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    let seed = 987654;
    const noise = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x3fffffff - 1;
    };
    // Each part: a noise snap plus two damped resonances (switch body and plastic shell).
    const parts = [
        { at: 0, gain: 1, snap: 0.0009, tones: [ [2600, 0.0035, 0.55], [5200, 0.0016, 0.35], [900, 0.006, 0.25] ] },
        { at: 0.07, gain: 0.45, snap: 0.0006, tones: [ [3400, 0.0025, 0.5], [6800, 0.0012, 0.3] ] },
    ];
    let peak = 0;
    for (let i = 0; i < length; i++) {
        const t = i / rate;
        let value = 0;
        for (const part of parts) {
            const local = t - part.at;
            if (local < 0) continue;
            let sample = noise() * Math.exp(-local / part.snap);
            for (const [frequency, decay, level] of part.tones) sample += Math.sin(2 * Math.PI * frequency * local) * Math.exp(-local / decay) * level;
            value += sample * part.gain;
        }
        data[i] = value;
        peak = Math.max(peak, Math.abs(value));
    }
    for (let i = 0; i < length; i++) data[i] = (data[i] / peak) * 0.8;
    return buffer;
}

/** The click sound for a style. Both are generated, so they always load and sound the same in export. */
export async function loadClickSound(context: BaseAudioContext, type: 'tick' | 'mouse'): Promise<{ buffer: AudioBuffer }> {
    return { buffer: type === 'mouse' ? createMouseClickSound(context) : createClickSound(context) };
}
