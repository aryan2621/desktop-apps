import { useRef, useState } from 'react';
import { Music, Repeat, Trash2, Upload, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { Button, Slider, Switch } from '../components/ui';
import { DEFAULT_MUSIC_VOLUME, type AudioMix, type MusicTrack } from './model';

const percent = (v: number) => `${Math.round(v * 100)}%`;
const seconds = (v: number) => `${v.toFixed(0)} s`;

/** Background music: pick a song, set its volume, where it starts, and whether it loops. */
export function MusicPanel({ projectId, audio, onChange }: { projectId: string; audio: AudioMix; onChange: (audio: AudioMix, key: string) => void }) {
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const music = audio.music;
    const set = (next: MusicTrack | null, key: string) => onChange({ ...audio, music: next }, key);

    const choose = async (file: File | undefined) => {
        if (!file) return;
        setBusy(true);
        try {
            const stored = await api.importMusic(projectId, file);
            set(
                { file: stored, name: file.name, volume: music?.volume ?? DEFAULT_MUSIC_VOLUME, muted: false, offset: 0, loop: music?.loop ?? true },
                'music-file'
            );
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setBusy(false);
            if (input.current) input.current.value = '';
        }
    };

    return (
        <div className='space-y-3 rounded-lg border border-line bg-panel-2 p-3'>
            <input ref={input} type='file' accept='audio/*,.mp3,.m4a,.aac,.wav,.aif,.aiff,.flac' className='hidden' onChange={(e) => choose(e.target.files?.[0])} />
            <div className='flex items-center justify-between gap-2 text-xs'>
                <span className='flex min-w-0 items-center gap-2'>
                    <Music className='h-3.5 w-3.5 shrink-0' />
                    <span className='truncate'>{music ? music.name : 'Music'}</span>
                </span>
                {music ? (
                    <span className='flex shrink-0 items-center gap-0.5'>
                        <Button
                            size='icon'
                            variant={music.muted ? 'danger' : 'ghost'}
                            className='h-7 w-7'
                            onClick={() => set({ ...music, muted: !music.muted }, 'music-mute')}
                            title={music.muted ? 'Unmute music' : 'Mute music'}
                            aria-label={music.muted ? 'Unmute music' : 'Mute music'}
                        >
                            {music.muted ? <VolumeX className='h-3.5 w-3.5' /> : <Volume2 className='h-3.5 w-3.5' />}
                        </Button>
                        <Button size='icon' variant='ghost' className='h-7 w-7' onClick={() => input.current?.click()} disabled={busy} title='Replace the song' aria-label='Replace the song'>
                            <Upload className='h-3.5 w-3.5' />
                        </Button>
                        <Button size='icon' variant='ghost' className='h-7 w-7' onClick={() => set(null, 'music-remove')} title='Remove music' aria-label='Remove music'>
                            <Trash2 className='h-3.5 w-3.5' />
                        </Button>
                    </span>
                ) : (
                    <Button size='sm' variant='subtle' onClick={() => input.current?.click()} disabled={busy}>
                        <Upload className='h-3.5 w-3.5' /> {busy ? 'Adding…' : 'Add music'}
                    </Button>
                )}
            </div>
            {music ? (
                <>
                    <Slider label='Volume' value={music.volume} min={0} max={1} step={0.05} format={percent} onChange={(volume) => set({ ...music, volume }, 'music-volume')} />
                    <Slider label='Start the song at' value={music.offset} min={0} max={120} step={1} format={seconds} onChange={(offset) => set({ ...music, offset }, 'music-offset')} />
                    <div className='flex items-center justify-between text-xs'>
                        <span className='flex items-center gap-2 text-muted'>
                            <Repeat className='h-3.5 w-3.5' /> Loop if the video is longer
                        </span>
                        <Switch label='Loop music' checked={music.loop} onChange={(loop) => set({ ...music, loop }, 'music-loop')} />
                    </div>
                </>
            ) : (
                <p className='text-xs text-muted'>Plays under your recording and is included in the export. Fade in/out below applies to it too.</p>
            )}
        </div>
    );
}
