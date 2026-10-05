import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, fileUrl, type Project, type Track } from '../lib/api';
import { gainOf, loadAudioTracks, loadMusic, scheduleTimeline, type AudioTrack, type ClickSounds, type TrackKind } from './audioSchedule';
import { positionAt, totalDuration, type AudioMix, type Clip } from './model';
import { loadClickSound } from './clickSound';

export type { ClickSounds } from './audioSchedule';

/** Videos are re-seeked when they drift this far from the audio clock, at most once per cooldown. */
const MAX_VIDEO_DRIFT = 0.1;
const RESYNC_COOLDOWN_MS = 800;
/** Lead time so every audio track starts on the same sample. */
const START_LEAD = 0.05;

/**
 * Plays the edited timeline. Audio is the master clock: everything audible is scheduled
 * sample-accurately with Web Audio by `scheduleTimeline` (the same code export uses), since
 * seeking <audio> elements causes audible gaps. The screen and camera videos follow the clock
 * at each clip's speed. "Output" times are positions on the edited timeline; "source" times
 * are in the recording.
 */
export function usePlayback(project: Project, clips: Clip[], clickSounds: ClickSounds, mix: AudioMix) {
    const screenRef = useRef<HTMLVideoElement>(null);
    const cameraRef = useRef<HTMLVideoElement>(null);
    const contextRef = useRef<AudioContext | null>(null);
    const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
    const masterRef = useRef<GainNode | null>(null);
    const trackGainsRef = useRef(new Map<TrackKind, GainNode>());
    const musicGainRef = useRef<GainNode | null>(null);
    const musicRef = useRef<AudioBuffer | null>(null);
    const clockRef = useRef<{ startedAt: number; startTime: number } | null>(null);
    const pausedAtRef = useRef(0);
    const clipsRef = useRef(clips);
    const clickSoundsRef = useRef(clickSounds);
    const mixRef = useRef(mix);
    const clickBufferRef = useRef<AudioBuffer | null>(null);
    /** Pitch-preserved copies of sped-up/slowed clips, keyed by track, range and speed. */
    const stretched = useRef(new Map<string, AudioBuffer>());
    const lastClipRef = useRef(-1);
    const lastResync = useRef(new WeakMap<HTMLVideoElement, number>());
    const [audio, setAudio] = useState<AudioTrack[] | null>(null);
    const [playing, setPlaying] = useState(false);

    const { screen, camera, systemAudio, microphone } = project.tracks;
    const total = totalDuration(clips);

    useEffect(() => {
        const context = new AudioContext({ sampleRate: 48_000 });
        contextRef.current = context;
        let cancelled = false;
        loadAudioTracks(
            context,
            [
                { kind: 'system', track: systemAudio },
                { kind: 'microphone', track: microphone },
            ],
            (track) => fileUrl(project, track.file)
        )
            .then((decoded) => !cancelled && setAudio(decoded))
            .catch((error) => {
                if (cancelled) return;
                toast.error('Could not load the audio of this recording.');
                api.log(`[editor ${project.id}] audio decode failed: ${error}`);
                setAudio([]);
            });
        return () => {
            cancelled = true;
            sourcesRef.current.forEach((source) => source.stop());
            sourcesRef.current = [];
            context.close();
        };
    }, [project, systemAudio, microphone]);

    // Decode the background music whenever a different song is chosen.
    const musicFile = mix.music?.file ?? null;
    useEffect(() => {
        const context = contextRef.current;
        musicRef.current = null;
        if (!context || !musicFile) {
            if (clockRef.current) play(now());
            return;
        }
        let cancelled = false;
        loadMusic(context, `${fileUrl(project, musicFile)}?v=${Date.now()}`)
            .then((buffer) => {
                if (cancelled) return;
                musicRef.current = buffer;
                if (clockRef.current) play(now());
            })
            .catch((error) => {
                if (cancelled) return;
                toast.error('Could not load the music file.');
                api.log(`[editor ${project.id}] music decode failed: ${error}`);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project, musicFile, audio]);

    /** Current output time. */
    const now = useCallback(() => {
        const context = contextRef.current;
        const clock = clockRef.current;
        if (!context || !clock) return pausedAtRef.current;
        return clock.startTime + (context.currentTime - clock.startedAt);
    }, []);

    const stopAudio = () => {
        sourcesRef.current.forEach((source) => source.stop());
        sourcesRef.current = [];
        masterRef.current?.disconnect();
        masterRef.current = null;
        trackGainsRef.current.clear();
        musicGainRef.current = null;
    };

    const videos = (): [HTMLVideoElement | null, Track | null][] => [
        [screenRef.current, screen],
        [cameraRef.current, camera],
    ];

    /** Puts the videos at output time `t`. Crossing into another clip always seeks. */
    const syncVideos = useCallback(
        (t: number, isPlaying: boolean, force = false) => {
            const position = positionAt(clipsRef.current, t);
            const clipChanged = position.index !== lastClipRef.current;
            lastClipRef.current = position.index;
            const timestamp = performance.now();
            for (const [element, track] of videos()) {
                if (!element || !track) continue;
                const local = position.source - track.offset;
                if (local < 0 || local >= track.duration) {
                    if (!element.paused) element.pause();
                    continue;
                }
                if (element.playbackRate !== position.clip.speed) element.playbackRate = position.clip.speed;
                const drifted = Math.abs(element.currentTime - local) > MAX_VIDEO_DRIFT * position.clip.speed;
                const cooledDown = timestamp - (lastResync.current.get(element) ?? 0) > RESYNC_COOLDOWN_MS;
                if (force || clipChanged || (drifted && !element.seeking && cooledDown)) {
                    lastResync.current.set(element, timestamp);
                    element.currentTime = local;
                }
                if (isPlaying && element.paused) element.play().catch(() => {});
                if (!isPlaying && !element.paused) element.pause();
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [screen, camera]
    );

    const play = useCallback(
        async (from: number) => {
            const context = contextRef.current;
            if (!context || !audio) return;
            const timeline = clipsRef.current;
            const length = totalDuration(timeline);
            const start = from >= length - 0.05 ? 0 : Math.max(0, from);
            // resume() has to be called inside the click for WebKit to allow sound.
            const resumed = context.resume();
            stopAudio();
            await resumed;

            const at = context.currentTime + START_LEAD;
            const scheduled = scheduleTimeline(
                context,
                context.destination,
                { tracks: audio, clips: timeline, mix: mixRef.current, clicks: clickSoundsRef.current, stretched: stretched.current, clickBuffer: clickBufferRef, music: musicRef.current },
                at,
                start
            );
            sourcesRef.current = scheduled.sources;
            masterRef.current = scheduled.master;
            trackGainsRef.current = scheduled.trackGains;
            musicGainRef.current = scheduled.musicGain;
            clockRef.current = { startedAt: at, startTime: start };
            lastClipRef.current = -1;
            syncVideos(start, true, true);
            setPlaying(true);
        },
        [audio, syncVideos]
    );

    const pause = useCallback(() => {
        const t = Math.min(now(), totalDuration(clipsRef.current));
        stopAudio();
        clockRef.current = null;
        pausedAtRef.current = t;
        syncVideos(t, false, true);
        setPlaying(false);
    }, [now, syncVideos]);

    const seek = useCallback(
        (t: number) => {
            const clamped = Math.min(Math.max(0, t), totalDuration(clipsRef.current));
            if (clockRef.current) {
                play(clamped);
            } else {
                pausedAtRef.current = clamped;
                syncVideos(clamped, false, true);
            }
        },
        [play, syncVideos]
    );

    // Volume and mute apply immediately; changing a fade reschedules from the same spot.
    useEffect(() => {
        const previous = mixRef.current;
        mixRef.current = mix;
        const context = contextRef.current;
        if (!context) return;
        for (const [kind, gain] of trackGainsRef.current) gain.gain.setTargetAtTime(gainOf(mix[kind]), context.currentTime, 0.02);
        if (mix.music && musicGainRef.current) musicGainRef.current.gain.setTargetAtTime(gainOf(mix.music), context.currentTime, 0.02);
        const musicMoved = previous.music?.offset !== mix.music?.offset || previous.music?.loop !== mix.music?.loop || !!previous.music !== !!mix.music;
        if ((previous.fadeIn !== mix.fadeIn || previous.fadeOut !== mix.fadeOut || musicMoved) && clockRef.current) play(now());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mix]);

    // Create the chosen click sound for this audio context.
    useEffect(() => {
        const context = contextRef.current;
        if (!context) return;
        let cancelled = false;
        loadClickSound(context, clickSounds.type).then(({ buffer }) => {
            if (cancelled) return;
            clickBufferRef.current = buffer;
            if (clockRef.current) play(now());
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clickSounds.type, audio]);

    // Changing the click sound while playing reschedules the audio from the same spot.
    useEffect(() => {
        const previous = clickSoundsRef.current;
        clickSoundsRef.current = clickSounds;
        const changed = previous.enabled !== clickSounds.enabled || previous.volume !== clickSounds.volume || previous.times !== clickSounds.times;
        if (changed && clockRef.current) play(now());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clickSounds.enabled, clickSounds.volume, clickSounds.times]);

    // Editing the clips while playing reschedules the audio from the same spot.
    useEffect(() => {
        clipsRef.current = clips;
        const length = totalDuration(clips);
        if (clockRef.current) {
            play(Math.min(now(), length));
        } else {
            pausedAtRef.current = Math.min(pausedAtRef.current, length);
            syncVideos(pausedAtRef.current, false, true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clips]);

    /** Called every animation frame: keeps videos in sync and stops at the end. Returns output time. */
    const tick = useCallback(() => {
        const t = now();
        if (clockRef.current) {
            const length = totalDuration(clipsRef.current);
            if (t >= length) {
                pause();
                pausedAtRef.current = length;
                return length;
            }
            syncVideos(t, true);
        }
        return t;
    }, [now, pause, syncVideos]);

    return { screenRef, cameraRef, audio, ready: audio !== null, playing, total, now, tick, play, pause, seek };
}
