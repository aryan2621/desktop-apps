import { useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { AppWindow, Camera, Check, Crop, FolderOpen, Mic, Monitor, Trash2, Volume2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, fileUrl, formatDuration, type Project } from '../lib/api';
import { IconButton, Kbd } from './ui';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "2 hours ago", "yesterday", … falling back to the date for anything older than a week. */
function whenRecorded(iso: string) {
    const date = new Date(iso);
    let value = (date.getTime() - Date.now()) / 1000;
    const steps: [Intl.RelativeTimeFormatUnit, number][] = [
        ['second', 60],
        ['minute', 60],
        ['hour', 24],
        ['day', 7],
    ];
    for (const [unit, size] of steps) {
        if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
        value /= size;
    }
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const SOURCE_ICONS = { display: Monitor, window: AppWindow, area: Crop };

export function RecordingsList({
    recordings,
    onOpen,
    onDeleted,
}: {
    recordings: Project[];
    onOpen: (project: Project) => void;
    onDeleted: () => void;
}) {
    if (recordings.length === 0) {
        return (
            <div className='flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-line p-10 text-center'>
                <EmptyIllustration />
                <div className='space-y-1'>
                    <p className='font-semibold'>No recordings yet</p>
                    <p className='max-w-xs text-sm text-muted'>Pick a screen, window or area on the left and start recording. Your recordings show up here.</p>
                </div>
                <p className='text-xs text-subtle'>
                    Tip: press <Kbd>⌘⇧R</Kbd> from any app to start and stop.
                </p>
            </div>
        );
    }

    return (
        <div className='grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4'>
            {recordings.map((project) => (
                <RecordingCard key={project.id} project={project} onOpen={() => onOpen(project)} onDeleted={onDeleted} />
            ))}
        </div>
    );
}

function RecordingCard({ project, onOpen, onDeleted }: { project: Project; onOpen: () => void; onDeleted: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const { tracks } = project;
    const SourceIcon = SOURCE_ICONS[project.source.type] ?? Monitor;

    const remove = async () => {
        try {
            await api.deleteRecording(project.id);
            onDeleted();
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    return (
        <div className='group overflow-hidden rounded-xl border border-line bg-panel shadow-sm transition-colors hover:border-line-strong'>
            <div className='relative'>
                <button onClick={onOpen} className='relative block aspect-video w-full overflow-hidden bg-stage' title='Open in editor' aria-label='Open in editor'>
                    <video
                        src={`${fileUrl(project, tracks.screen.file)}#t=0.5`}
                        preload='metadata'
                        muted
                        className='h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.02]'
                    />
                    <span className='absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100' />
                    <span className='absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white'>{formatDuration(project.duration)}</span>
                    <span className='absolute bottom-2 right-2 flex gap-1 text-white'>
                        {tracks.microphone && (
                            <span className='rounded-md bg-black/60 p-1' title='Has microphone audio'>
                                <Mic className='h-3 w-3' />
                            </span>
                        )}
                        {tracks.systemAudio && (
                            <span className='rounded-md bg-black/60 p-1' title='Has system audio'>
                                <Volume2 className='h-3 w-3' />
                            </span>
                        )}
                        {tracks.camera && (
                            <span className='rounded-md bg-black/60 p-1' title='Has camera'>
                                <Camera className='h-3 w-3' />
                            </span>
                        )}
                    </span>
                </button>
                {/* Actions appear on hover (and stay while confirming a delete). */}
                <div className={`absolute right-2 top-2 flex gap-1 transition-opacity ${confirming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    {confirming ? (
                        <>
                            <IconButton label='Delete for good' size='icon-sm' variant='danger' className='bg-panel/90 backdrop-blur' onClick={remove}>
                                <Check className='h-3.5 w-3.5' />
                            </IconButton>
                            <IconButton label='Keep recording' size='icon-sm' variant='subtle' className='backdrop-blur' onClick={() => setConfirming(false)}>
                                <X className='h-3.5 w-3.5' />
                            </IconButton>
                        </>
                    ) : (
                        <>
                            <IconButton label='Show in Finder' size='icon-sm' variant='subtle' className='bg-panel/90 backdrop-blur' onClick={() => revealItemInDir(project.path)}>
                                <FolderOpen className='h-3.5 w-3.5' />
                            </IconButton>
                            <IconButton label='Delete recording' size='icon-sm' variant='subtle' className='bg-panel/90 backdrop-blur' onClick={() => setConfirming(true)}>
                                <Trash2 className='h-3.5 w-3.5' />
                            </IconButton>
                        </>
                    )}
                </div>
            </div>
            <button onClick={onOpen} className='flex w-full items-center gap-3 px-3 py-2.5 text-left' title='Open in editor'>
                <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted'>
                    <SourceIcon className='h-4 w-4' />
                </span>
                <span className='min-w-0'>
                    <span className='block truncate text-sm font-medium'>{project.source.name}</span>
                    <span className='block text-xs text-subtle' title={new Date(project.createdAt).toLocaleString()}>
                        {whenRecorded(project.createdAt)}
                    </span>
                </span>
            </button>
        </div>
    );
}

/** A simple screen-with-record-dot drawing for the empty library. */
function EmptyIllustration() {
    return (
        <svg width='120' height='88' viewBox='0 0 120 88' fill='none' aria-hidden>
            <rect x='8' y='6' width='104' height='66' rx='10' className='fill-panel-2 stroke-line-strong' strokeWidth='2' />
            <rect x='18' y='16' width='84' height='46' rx='5' className='fill-stage' />
            <path d='M50 82h20' className='stroke-line-strong' strokeWidth='3' strokeLinecap='round' />
            <circle cx='60' cy='39' r='11' className='fill-record/90' />
            <circle cx='60' cy='39' r='16' className='stroke-record/40' strokeWidth='2' />
            <path d='M26 22h10M26 22v8M94 56H84M94 56v-8' className='stroke-accent' strokeWidth='2.5' strokeLinecap='round' />
        </svg>
    );
}
