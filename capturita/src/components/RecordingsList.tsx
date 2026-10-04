import { useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { AppWindow, Camera, Check, Clock, Crop, Film, FolderOpen, Mic, Monitor, MousePointerClick, Sparkles, Trash2, Volume2, X } from 'lucide-react';
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

/** "Good morning" … by the time of day. */
function greeting() {
    const hour = new Date().getHours();
    return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

/** Total length in words: "45 sec", "12 min", "1 h 5 min". */
function totalLength(seconds: number) {
    if (seconds < 60) return `${Math.round(seconds)} sec`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The library's heading: a greeting, and how much is in it. */
export function LibraryHeader({ recordings }: { recordings: Project[] }) {
    const seconds = recordings.reduce((sum, project) => sum + project.duration, 0);
    return (
        <div className='flex flex-wrap items-end justify-between gap-3'>
            <div>
                <p className='text-sm text-subtle'>{greeting()}</p>
                <h2 className='font-serif text-3xl font-medium tracking-tight'>
                    {recordings.length ? 'Your recordings' : "Let's make your first one"}
                </h2>
            </div>
            {recordings.length > 0 && (
                <div className='flex gap-2'>
                    <span className='inline-flex items-center gap-1.5 rounded-full bg-panel-2 px-3 py-1 text-xs text-muted'>
                        <Film className='h-3.5 w-3.5' />
                        {recordings.length} {recordings.length === 1 ? 'recording' : 'recordings'}
                    </span>
                    <span className='inline-flex items-center gap-1.5 rounded-full bg-panel-2 px-3 py-1 text-xs text-muted'>
                        <Clock className='h-3.5 w-3.5' />
                        {totalLength(seconds)}
                    </span>
                </div>
            )}
        </div>
    );
}

/** Groups newest-first recordings under Today / Yesterday / This week / Earlier. */
function groupByDay(recordings: Project[]) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    const groups: { label: string; items: Project[] }[] = [];
    for (const project of recordings) {
        const time = new Date(project.createdAt).getTime();
        const label =
            time >= startOfToday.getTime()
                ? 'Today'
                : time >= startOfToday.getTime() - day
                  ? 'Yesterday'
                  : time >= startOfToday.getTime() - 6 * day
                    ? 'This week'
                    : 'Earlier';
        const last = groups[groups.length - 1];
        if (last?.label === label) last.items.push(project);
        else groups.push({ label, items: [project] });
    }
    return groups;
}

const STEPS = [
    { icon: MousePointerClick, title: 'Pick what to record', text: 'A whole screen, one window, or an area — on the left.' },
    { icon: Film, title: 'Record', text: 'Hit Start, or press ⌘⇧R from any app. Press it again to stop.' },
    { icon: Sparkles, title: 'Polish it', text: 'Auto-zooms, captions, hidden private info, then export or upload.' },
];

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
            <div className='flex flex-1 flex-col items-center justify-center gap-8 rounded-2xl border border-dashed border-line p-10 text-center'>
                <EmptyIllustration />
                <ol className='grid w-full max-w-2xl gap-3 text-left sm:grid-cols-3'>
                    {STEPS.map((step, index) => (
                        <li key={step.title} className='rounded-xl border border-line bg-panel p-4'>
                            <div className='mb-3 flex items-center gap-2'>
                                <span className='flex h-6 w-6 items-center justify-center rounded-full bg-accent font-serif text-xs font-medium text-accent-fg'>
                                    {index + 1}
                                </span>
                                <step.icon className='h-4 w-4 text-muted' />
                            </div>
                            <p className='text-sm font-medium'>{step.title}</p>
                            <p className='mt-1 text-xs leading-relaxed text-muted'>{step.text}</p>
                        </li>
                    ))}
                </ol>
                <p className='text-xs text-subtle'>
                    Tip: <Kbd>⌘⇧R</Kbd> starts and stops a recording from any app.
                </p>
            </div>
        );
    }

    return (
        <div className='space-y-6'>
            {groupByDay(recordings).map((group) => (
                <section key={group.label} className='space-y-3'>
                    <h3 className='flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-subtle'>
                        {group.label}
                        <span className='h-px flex-1 bg-line' />
                    </h3>
                    <div className='grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4'>
                        {group.items.map((project) => (
                            <RecordingCard key={project.id} project={project} onOpen={() => onOpen(project)} onDeleted={onDeleted} />
                        ))}
                    </div>
                </section>
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
