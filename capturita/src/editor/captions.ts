import { api, fileUrl, type Project } from '../lib/api';
import { loadAudioTracks, type TrackKind } from './audioSchedule';
import { FILLER, groupCaptions, type Caption, type CaptionWord } from './model';

const WHISPER_RATE = 16_000;

/** Which recorded sound to caption: your voice, what the Mac played, or both. */
export type CaptionSource = 'microphone' | 'both' | 'system';

export const CAPTION_SOURCES: { value: CaptionSource; label: string }[] = [
    { value: 'microphone', label: 'Microphone only (you)' },
    { value: 'both', label: 'Microphone and system audio' },
    { value: 'system', label: 'System audio only (videos, calls)' },
];

/** The sound tracks this recording has, your microphone first. */
export function speechSources(project: Project): TrackKind[] {
    const kinds: TrackKind[] = [];
    if (project.tracks.microphone) kinds.push('microphone');
    if (project.tracks.systemAudio) kinds.push('system');
    return kinds;
}

/** Your microphone if there is one, otherwise system audio. */
export const defaultCaptionSource = (project: Project): CaptionSource => (project.tracks.microphone ? 'microphone' : 'system');

const tracksOf = (source: CaptionSource): TrackKind[] => (source === 'both' ? ['microphone', 'system'] : [source]);

/** One track as 16 kHz mono on the source timeline, so Whisper's word times are source times. */
async function trackAudio(project: Project, kind: TrackKind) {
    const length = Math.max(1, Math.ceil(project.duration * WHISPER_RATE));
    const context = new OfflineAudioContext(1, length, WHISPER_RATE);
    const track = kind === 'microphone' ? project.tracks.microphone : project.tracks.systemAudio;
    const tracks = await loadAudioTracks(context, [{ kind, track }], (t) => fileUrl(project, t.file));
    for (const { track, buffer } of tracks) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(Math.max(0, track.offset));
    }
    return (await context.startRendering()).getChannelData(0);
}

/**
 * Transcribes the chosen sound and groups the words into captions; the filler words left out are
 * returned too. Each track is transcribed on its own: your mic and system audio often hold
 * different people and languages (you in English, a video in Hindi), and mixed together Whisper
 * would hear one language for both.
 */
export async function makeCaptions(project: Project, language: string, source: CaptionSource): Promise<{ items: Caption[]; fillers: CaptionWord[] }> {
    const available = speechSources(project);
    const words: CaptionWord[] = [];
    for (const kind of tracksOf(source).filter((k) => available.includes(k))) {
        words.push(...(await api.transcribe(await trackAudio(project, kind), language)));
    }
    words.sort((a, b) => a.start - b.start);
    return { items: groupCaptions(words), fillers: words.filter((w) => FILLER.test(w.text.trim())) };
}
