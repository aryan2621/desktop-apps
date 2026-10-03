import { api, fileUrl, type Project } from '../lib/api';
import { loadAudioTracks, type TrackKind } from './audioSchedule';
import { FILLER, groupCaptions, type Caption, type CaptionWord } from './model';

const WHISPER_RATE = 16_000;

/**
 * Mixes the recorded voice (microphone, plus system audio for calls and videos) to 16 kHz mono
 * on the source timeline, so Whisper's word times are source times.
 */
async function speechAudio(project: Project, sources: TrackKind[]) {
    const length = Math.max(1, Math.ceil(project.duration * WHISPER_RATE));
    const context = new OfflineAudioContext(1, length, WHISPER_RATE);
    const tracks = await loadAudioTracks(
        context,
        sources.map((kind) => ({ kind, track: kind === 'microphone' ? project.tracks.microphone : project.tracks.systemAudio })),
        (track) => fileUrl(project, track.file)
    );
    for (const { track, buffer } of tracks) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(Math.max(0, track.offset));
    }
    return (await context.startRendering()).getChannelData(0);
}

/** The tracks with speech in them, best first. */
export function speechSources(project: Project): TrackKind[] {
    const kinds: TrackKind[] = [];
    if (project.tracks.microphone) kinds.push('microphone');
    if (project.tracks.systemAudio) kinds.push('system');
    return kinds;
}

/** Transcribes the recording and groups the words into captions; the filler words left out are returned too. */
export async function makeCaptions(project: Project, language: string, sources: TrackKind[]): Promise<{ items: Caption[]; fillers: CaptionWord[] }> {
    const audio = await speechAudio(project, sources);
    const words = await api.transcribe(audio, language);
    return { items: groupCaptions(words), fillers: words.filter((w) => FILLER.test(w.text.trim())) };
}
