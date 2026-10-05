import { api, fileUrl, type Project } from '../lib/api';
import { loadAudioTracks } from './audioSchedule';
import { FILLER, groupCaptions, type Caption, type CaptionWord } from './model';

const WHISPER_RATE = 16_000;

/** Captions are made from your voice: the microphone track. */
export const hasVoice = (project: Project) => !!project.tracks.microphone;

/** The microphone track as 16 kHz mono on the source timeline, so Whisper's word times are source times. */
async function voiceAudio(project: Project) {
    const length = Math.max(1, Math.ceil(project.duration * WHISPER_RATE));
    const context = new OfflineAudioContext(1, length, WHISPER_RATE);
    const tracks = await loadAudioTracks(context, [{ kind: 'microphone', track: project.tracks.microphone }], (track) => fileUrl(project, track.file));
    for (const { track, buffer } of tracks) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(Math.max(0, track.offset));
    }
    return (await context.startRendering()).getChannelData(0);
}

/** Transcribes what you said and groups the words into captions; the filler words left out are returned too. */
export async function makeCaptions(project: Project, language: string): Promise<{ items: Caption[]; fillers: CaptionWord[] }> {
    const words = await api.transcribe(await voiceAudio(project), language);
    return { items: groupCaptions(words), fillers: words.filter((w) => FILLER.test(w.text.trim())) };
}
