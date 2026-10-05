import { invoke } from '@tauri-apps/api/core';
import {
    ALL_FORMATS,
    AudioBufferSource,
    BlobSource,
    CanvasSource,
    Input,
    Mp4OutputFormat,
    Output,
    QUALITY_HIGH,
    StreamTarget,
    UrlSource,
    VideoSampleSink,
    type StreamTargetChunk,
    type VideoSample,
} from 'mediabunny';
import { api, fileUrl, type CursorData, type Project, type VideoTrack } from '../lib/api';
import { loadAudioTracks, loadMusic, scheduleTimeline } from './audioSchedule';
import { loadClickSound } from './clickSound';
import { aspectRatio, positionAt, totalDuration, type Edit } from './model';
import { drawFrame, type FrameSource } from './render';

export type Resolution = 720 | 1080 | 2160;

export interface ExportSettings {
    /** Pixel size of the frame's shorter side. */
    resolution: Resolution;
    fps: 30 | 60;
}

export interface ExportProgress {
    phase: 'audio' | 'video' | 'finishing';
    /** 0 to 1 over the whole export. */
    progress: number;
}

const SAMPLE_RATE = 48_000;
const AUDIO_BITRATE = 192_000;
/** Audio is added in slices a little ahead of the video so the file stays interleaved. */
const AUDIO_SLICE = 1;
/** Rendering the audio mix is quick; count it as this share of the progress bar. */
const AUDIO_SHARE = 0.1;
const WRITE_CHUNK = 8 * 1024 * 1024;

export class ExportCancelled extends Error {
    constructor() {
        super('Export cancelled');
    }
}

/** Output frame size: the shorter side is `resolution`, both sides even (as H.264 requires). */
export function exportSize(edit: Edit, project: Project, resolution: Resolution) {
    const aspect = aspectRatio(edit, project);
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    return aspect >= 1 ? { width: even(resolution * aspect), height: resolution } : { width: resolution, height: even(resolution / aspect) };
}

/**
 * Renders the edited video to an MP4 in ~/Movies/Capturita/Exports and returns its path.
 * Frames are decoded from the recording with WebCodecs, drawn with the same renderer as the
 * editor preview, and encoded with the hardware H.264 encoder; audio is mixed offline with the
 * same scheduler as playback and encoded to AAC.
 */
/** The name an export gets unless the user types another: the source and when it was recorded. */
export function defaultExportName(project: Project) {
    const date = new Date(project.createdAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    return `${project.source.name} ${date}`;
}

export async function exportVideo(options: {
    project: Project;
    edit: Edit;
    cursor: CursorData | null;
    settings: ExportSettings;
    /** The MP4's name without extension; a number is added if the name is taken. */
    fileName?: string;
    onProgress: (progress: ExportProgress) => void;
    signal: AbortSignal;
}): Promise<string> {
    const { project, edit, cursor, settings, onProgress, signal } = options;
    const { screen, camera } = project.tracks;
    const total = totalDuration(edit.clips);
    const { width, height } = exportSize(edit, project, settings.resolution);
    const checkCancelled = () => {
        if (signal.aborted) throw new ExportCancelled();
    };

    const path = await invoke<string>('export_open', { name: options.fileName?.trim().replace(/\.mp4$/i, '').trim() || defaultExportName(project) });
    const inputs: Input[] = [];
    let output: Output | null = null;

    try {
        // 1. Mix the audio offline.
        onProgress({ phase: 'audio', progress: 0 });
        const mixed = await renderAudio(project, edit, cursor, total);
        checkCancelled();

        // 2. Set up the MP4 file, streamed to disk in chunks.
        const writable = new WritableStream<StreamTargetChunk>({
            write: (chunk) => invoke('export_write', chunk.data, { headers: { position: String(chunk.position) } }),
        });
        output = new Output({
            format: new Mp4OutputFormat({ fastStart: false }),
            target: new StreamTarget(writable, { chunked: true, chunkSize: WRITE_CHUNK }),
        });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create a drawing surface for the export');
        const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
        output.addVideoTrack(videoSource, { frameRate: settings.fps });
        const audioSource = mixed ? new AudioBufferSource({ codec: 'aac', bitrate: AUDIO_BITRATE }) : null;
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();

        // 3. Decoders for the screen and camera tracks.
        // Read the recording in ranges; if that fails, fall back to loading the whole file.
        const open = async (track: VideoTrack) => {
            const url = fileUrl(project, track.file);
            const tryOpen = async (source: UrlSource | BlobSource) => {
                const input = new Input({ formats: ALL_FORMATS, source });
                inputs.push(input);
                const videoTrack = await input.getPrimaryVideoTrack();
                if (!videoTrack) throw new Error(`${track.file} has no video`);
                return new VideoSampleSink(videoTrack);
            };
            try {
                return await tryOpen(new UrlSource(url));
            } catch (error) {
                api.log(`[export] range reads failed for ${track.file} (${error}); loading the whole file`);
                const response = await fetch(url);
                if (!response.ok) throw new Error(`${track.file}: HTTP ${response.status}`);
                return tryOpen(new BlobSource(await response.blob()));
            }
        };
        const screenSink = await open(screen);
        const cameraSink = camera && edit.camera.visible ? await open(camera) : null;

        // Every output frame's position in the recording (cuts and speed applied).
        const frameCount = Math.max(1, Math.round(total * settings.fps));
        const positions = Array.from({ length: frameCount }, (_, i) => positionAt(edit.clips, i / settings.fps).source);
        const localTimes = (track: VideoTrack) =>
            positions.map((source) => Math.min(Math.max(0, source - track.offset), Math.max(0, track.duration - 0.001)));
        const screenFrames = screenSink.samplesAtTimestamps(localTimes(screen))[Symbol.asyncIterator]();
        const cameraFrames = cameraSink && camera ? cameraSink.samplesAtTimestamps(localTimes(camera))[Symbol.asyncIterator]() : null;
        // WebKit ignores the source rectangle when drawing a VideoFrame (it always draws the whole
        // frame), which broke crop, zoom and the camera's square crop. Copy each frame onto a canvas
        // first; drawing from a canvas honours the source rectangle.
        const screenCanvas = document.createElement('canvas');
        const cameraCanvas = document.createElement('canvas');
        const asSource = (sample: VideoSample | null | undefined, canvas: HTMLCanvasElement): FrameSource | null => {
            if (!sample) return null;
            const frameWidth = sample.displayWidth;
            const frameHeight = sample.displayHeight;
            if (canvas.width !== frameWidth) canvas.width = frameWidth;
            if (canvas.height !== frameHeight) canvas.height = frameHeight;
            canvas.getContext('2d')?.drawImage(sample.toCanvasImageSource(), 0, 0, frameWidth, frameHeight);
            return { image: canvas, width: frameWidth, height: frameHeight };
        };

        // 4. Draw and encode every frame, feeding audio just ahead of it.
        let audioAddedUntil = 0;
        const addAudioUntil = async (until: number) => {
            if (!audioSource || !mixed) return;
            while (audioAddedUntil < Math.min(until, total)) {
                const end = Math.min(total, audioAddedUntil + AUDIO_SLICE);
                await audioSource.add(sliceAudio(mixed, audioAddedUntil, end));
                audioAddedUntil = end;
            }
        };

        for (let i = 0; i < frameCount; i++) {
            checkCancelled();
            const time = i / settings.fps;
            await addAudioUntil(time + AUDIO_SLICE);
            const screenSample = await nextSample(screenFrames);
            const cameraSample = cameraFrames ? await nextSample(cameraFrames) : null;
            const cameraLocal = camera ? positions[i] - camera.offset : -1;
            try {
                drawFrame(ctx, width, height, {
                    edit,
                    project,
                    screen: asSource(screenSample, screenCanvas),
                    camera: asSource(cameraSample, cameraCanvas),
                    cameraActive: !!camera && cameraLocal >= 0 && cameraLocal < camera.duration,
                    cursor,
                    time: positions[i],
                });
                await videoSource.add(time, 1 / settings.fps);
            } finally {
                screenSample?.close();
                cameraSample?.close();
            }
            if (i % 10 === 0) onProgress({ phase: 'video', progress: AUDIO_SHARE + (1 - AUDIO_SHARE) * (i / frameCount) });
        }
        await addAudioUntil(total);

        // 5. Finish the file.
        onProgress({ phase: 'finishing', progress: 1 });
        await output.finalize();
        await invoke('export_close', { keep: true });
        return path;
    } catch (error) {
        if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
        await invoke('export_close', { keep: false }).catch(() => {});
        throw error;
    } finally {
        inputs.forEach((input) => input.dispose());
    }
}

async function nextSample(frames: AsyncIterator<VideoSample | null>) {
    const result = await frames.next();
    return result.done ? null : result.value;
}

/** Mixes every audio source of the edited timeline into one buffer, or null if it's silent. */
async function renderAudio(project: Project, edit: Edit, cursor: CursorData | null, total: number): Promise<AudioBuffer | null> {
    const clickTimes = cursor?.clicks.map(([t]) => t) ?? [];
    const hasClicks = edit.cursor.clickSound && clickTimes.length > 0;
    const music = edit.audio.music;
    if (!project.tracks.systemAudio && !project.tracks.microphone && !hasClicks && !music) return null;

    const context = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * SAMPLE_RATE)), SAMPLE_RATE);
    const tracks = await loadAudioTracks(
        context,
        [
            { kind: 'system', track: project.tracks.systemAudio },
            { kind: 'microphone', track: project.tracks.microphone },
        ],
        (track) => fileUrl(project, track.file)
    );
    scheduleTimeline(
        context,
        context.destination,
        {
            tracks,
            clips: edit.clips,
            mix: edit.audio,
            clicks: { enabled: edit.cursor.clickSound, type: edit.cursor.clickSoundType, volume: edit.cursor.clickVolume, times: clickTimes },
            stretched: new Map(),
            clickBuffer: { current: hasClicks ? (await loadClickSound(context, edit.cursor.clickSoundType)).buffer : null },
            music: music ? await loadMusic(context, fileUrl(project, music.file)) : null,
        },
        0,
        0
    );
    return context.startRendering();
}

/** Copies a time range of a buffer into a new one. */
function sliceAudio(buffer: AudioBuffer, from: number, to: number) {
    const start = Math.floor(from * buffer.sampleRate);
    const end = Math.min(buffer.length, Math.floor(to * buffer.sampleRate));
    const slice = new AudioBuffer({ length: Math.max(1, end - start), numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        slice.copyToChannel(buffer.getChannelData(channel).subarray(start, end), channel);
    }
    return slice;
}
