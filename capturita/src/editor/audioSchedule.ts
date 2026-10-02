import type { Track } from '../lib/api';
import { createClickSound } from './clickSound';
import { clipStarts, positionAt, totalDuration, type AudioMix, type ClickSoundType, type Clip, type TrackLevel } from './model';
import { timeStretch } from './timeStretch';

export type TrackKind = 'system' | 'microphone';

export interface AudioTrack {
    kind: TrackKind;
    track: Track;
    buffer: AudioBuffer;
}

export interface ClickSounds {
    enabled: boolean;
    type: ClickSoundType;
    /** 0 to 1. */
    volume: number;
    /** Source times of the recorded clicks. */
    times: number[];
}

export interface ScheduleOptions {
    tracks: AudioTrack[];
    clips: Clip[];
    mix: AudioMix;
    clicks: ClickSounds;
    /** Cache of pitch-preserved copies of sped-up/slowed clips, reused across calls. */
    stretched: Map<string, AudioBuffer>;
    /** The click sound for this context (the synthesized tick is created if empty). */
    clickBuffer: { current: AudioBuffer | null };
    /** Decoded background music (settings are in `mix.music`). */
    music?: AudioBuffer | null;
}

export interface Scheduled {
    sources: AudioBufferSourceNode[];
    /** Carries the fades; disconnect it to silence everything scheduled. */
    master: GainNode;
    trackGains: Map<TrackKind, GainNode>;
    /** Background music volume, adjustable while playing. */
    musicGain: GainNode | null;
}

export const gainOf = (level: TrackLevel) => (level.muted ? 0 : level.volume);

/**
 * Schedules the whole edited timeline from output time `start`, beginning at context time `at`.
 * Shared by live playback (AudioContext) and export (OfflineAudioContext) so both sound the same:
 * kept clips of every track (sped-up clips are time-stretched to keep their pitch), the click
 * sound, each track's volume/mute, and fades at the start and end of the video.
 */
export function scheduleTimeline(context: BaseAudioContext, destination: AudioNode, options: ScheduleOptions, at: number, start: number): Scheduled {
    const { tracks, clips, mix, clicks, stretched } = options;
    const length = totalDuration(clips);
    const starts = clipStarts(clips);
    const sources: AudioBufferSourceNode[] = [];

    const master = context.createGain();
    master.connect(destination);
    scheduleFades(master, mix, at, start, length);

    const trackGains = new Map<TrackKind, GainNode>();
    for (const { kind } of tracks) {
        const gain = context.createGain();
        gain.gain.value = gainOf(mix[kind]);
        gain.connect(master);
        trackGains.set(kind, gain);
    }

    const { index: first, source: firstSource } = positionAt(clips, start);
    for (let index = first; index < clips.length; index++) {
        const clip = clips[index];
        const segmentStart = index === first ? firstSource : clip.start;
        for (const { kind, track, buffer } of tracks) {
            // The part of this clip that the track actually covers, in source time.
            const covered = Math.max(clip.start, track.offset);
            const a = Math.max(segmentStart, track.offset);
            const b = Math.min(clip.end, track.offset + buffer.duration);
            if (b - a <= 0.001) continue;
            const node = context.createBufferSource();
            node.connect(trackGains.get(kind)!);
            const when = Math.max(context.currentTime, at + (starts[index] + (a - clip.start) / clip.speed - start));
            if (clip.speed === 1) {
                node.buffer = buffer;
                node.start(when, a - track.offset, b - a);
            } else {
                // Play a time-stretched copy at normal rate so the pitch stays the same.
                const key = `${track.file}:${covered}:${b}:${clip.speed}`;
                let copy = stretched.get(key);
                if (!copy) {
                    copy = timeStretch(context, buffer, covered - track.offset, b - track.offset, clip.speed);
                    stretched.set(key, copy);
                }
                node.buffer = copy;
                node.start(when, (a - covered) / clip.speed);
            }
            sources.push(node);
        }
    }

    // Music runs along the output timeline, so cuts and speed changes don't affect it.
    let musicGain: GainNode | null = null;
    const music = mix.music;
    if (music && options.music && start < length) {
        const buffer = options.music;
        musicGain = context.createGain();
        musicGain.gain.value = gainOf(music);
        musicGain.connect(master);
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(musicGain);
        const into = music.offset + start;
        const remaining = length - start;
        if (music.loop) {
            node.loop = true;
            node.start(at, into % buffer.duration);
            node.stop(at + remaining);
        } else if (into < buffer.duration) {
            node.start(at, into, Math.min(remaining, buffer.duration - into));
        }
        sources.push(node);
    }

    if (clicks.enabled && clicks.volume > 0 && clicks.times.length > 0) {
        options.clickBuffer.current ??= createClickSound(context);
        const gain = context.createGain();
        gain.gain.value = clicks.volume;
        gain.connect(master);
        for (let index = first; index < clips.length; index++) {
            const clip = clips[index];
            const from = index === first ? firstSource : clip.start;
            for (const t of clicks.times) {
                if (t < from || t >= clip.end) continue;
                const when = at + (starts[index] + (t - clip.start) / clip.speed - start);
                if (when < context.currentTime) continue;
                const node = context.createBufferSource();
                node.buffer = options.clickBuffer.current;
                node.connect(gain);
                node.start(when);
                sources.push(node);
            }
        }
    }

    return { sources, master, trackGains, musicGain };
}

/** Fade in at the start and out at the end of the whole edited video, as a gain automation. */
function scheduleFades(gain: GainNode, mix: AudioMix, at: number, start: number, length: number) {
    const { fadeIn, fadeOut } = mix;
    const level = (t: number) => Math.max(0, Math.min(1, fadeIn > 0 ? t / fadeIn : 1, fadeOut > 0 ? (length - t) / fadeOut : 1));
    gain.gain.setValueAtTime(level(start), at);
    const points = [fadeIn, length - fadeOut, length].filter((t) => t > start).sort((a, b) => a - b);
    for (const t of points) gain.gain.linearRampToValueAtTime(level(t), at + (t - start));
}

/** Fetches and decodes a project's background music file. */
export async function loadMusic(context: BaseAudioContext, url: string): Promise<AudioBuffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`music: HTTP ${response.status}`);
    return context.decodeAudioData(await response.arrayBuffer());
}

/** Fetches and decodes the recording's audio tracks. */
export async function loadAudioTracks(
    context: BaseAudioContext,
    tracks: { kind: TrackKind; track: Track | null }[],
    url: (track: Track) => string
): Promise<AudioTrack[]> {
    const present = tracks.filter((t): t is { kind: TrackKind; track: Track } => !!t.track);
    return Promise.all(
        present.map(async ({ kind, track }) => {
            const response = await fetch(url(track));
            if (!response.ok) throw new Error(`${track.file}: HTTP ${response.status}`);
            return { kind, track, buffer: await context.decodeAudioData(await response.arrayBuffer()) };
        })
    );
}
