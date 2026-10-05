import { useEffect, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { AppWindow, Camera, Crop, Film, FolderOpen, Mic, Monitor, MousePointerClick, Plus, Sparkles, Trash2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, fileUrl, formatDuration, type Project } from '../lib/api';
import { Button, IconButton, Kbd, cx } from './ui';

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

/** The library's heading. */
export function LibraryHeader({ recordings }: { recordings: Project[] }) {
    return (
        <div className='flex items-baseline gap-3'>
            <h2 className='font-serif text-2xl font-medium tracking-tight'>{recordings.length ? 'Recordings' : "Let's make your first one"}</h2>
            {recordings.length > 0 && <span className='text-sm text-subtle'>{recordings.length}</span>}
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
    { icon: MousePointerClick, title: 'Pick what to record', text: 'Click New recording: a whole screen, one window, or an area.' },
    { icon: Film, title: 'Record', text: 'Hit Start, or press ⌘⇧R from any app. Press it again to stop.' },
    { icon: Sparkles, title: 'Polish it', text: 'Auto-zooms, captions, hidden private info, then export or upload.' },
];

export type LibraryView = 'cards' | 'table';

/** Shown instead of the library before the first recording. */
export function EmptyLibrary({ onNew }: { onNew: () => void }) {
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
            <Button variant='primary' onClick={onNew}>
                <Plus className='h-4 w-4' /> New recording
            </Button>
            <p className='text-xs text-subtle'>
                Tip: <Kbd>⌘⇧R</Kbd> starts and stops a recording from any app.
            </p>
        </div>
    );
}

/** The recordings, as cards or a table. A click opens one in the editor; more actions are in its menu. */
export function RecordingsList({ recordings, view, onOpen, onDeleted }: { recordings: Project[]; view: LibraryView; onOpen: (project: Project) => void; onDeleted: () => void }) {
    if (view === 'table') {
        return (
            <div className='rounded-xl border border-line bg-panel'>
                <table className='w-full table-fixed text-sm'>
                    <thead className='border-b border-line bg-panel-2 text-left text-[11px] font-semibold uppercase tracking-wider text-subtle [&_th:first-child]:rounded-tl-xl [&_th:last-child]:rounded-tr-xl'>
                        <tr>
                            <th className='w-[46%] px-3 py-2 font-semibold'>Recording</th>
                            <th className='px-3 py-2 font-semibold'>Recorded</th>
                            <th className='w-20 px-3 py-2 font-semibold'>Length</th>
                            <th className='w-24 px-3 py-2 font-semibold'>Tracks</th>
                            <th className='w-20 px-3 py-2' />
                        </tr>
                    </thead>
                    <tbody>
                        {recordings.map((project) => {
                            const SourceIcon = SOURCE_ICONS[project.source.type] ?? Monitor;
                            return (
                                <tr key={project.id} onClick={() => onOpen(project)} className='group cursor-default border-b border-line last:border-0 hover:bg-panel-2' title='Open in the editor'>
                                    <td className='px-3 py-2'>
                                        <span className='flex min-w-0 items-center gap-3'>
                                            <span className='relative block aspect-video w-16 shrink-0 overflow-hidden rounded-md bg-stage'>
                                                <Thumbnail project={project} />
                                            </span>
                                            <SourceIcon className='h-3.5 w-3.5 shrink-0 text-subtle' />
                                            <span className='truncate font-medium'>{project.source.name}</span>
                                        </span>
                                    </td>
                                    <td className='truncate px-3 py-2 text-muted' title={new Date(project.createdAt).toLocaleString()}>
                                        {whenRecorded(project.createdAt)}
                                    </td>
                                    <td className='px-3 py-2 font-mono text-xs text-muted'>{formatDuration(project.duration)}</td>
                                    <td className='px-3 py-2'>
                                        <TrackIcons project={project} />
                                    </td>
                                    <td className='px-2 py-2' onClick={(e) => e.stopPropagation()}>
                                        <RecordingMenu project={project} onDeleted={onDeleted} />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
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
                    <div className='grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4'>
                        {group.items.map((project) => (
                            <RecordingCard key={project.id} project={project} onOpen={() => onOpen(project)} onDeleted={onDeleted} />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

/** Poster frames are made one at a time, so a big library doesn't decode dozens of videos at once. */
let posterQueue: Promise<unknown> = Promise.resolve();

/** Grabs a frame half a second in, saves it as thumb.jpg in the project and returns a URL for it. */
function makePoster(project: Project) {
    const job = posterQueue.then(
        () =>
            new Promise<string>((resolve, reject) => {
                const video = document.createElement('video');
                video.muted = true;
                video.preload = 'auto';
                video.src = fileUrl(project, project.tracks.screen.file);
                const done = () => {
                    video.removeAttribute('src');
                    video.load();
                };
                video.onerror = () => {
                    done();
                    reject(new Error('Could not read the recording'));
                };
                video.onloadeddata = () => {
                    video.currentTime = Math.min(0.5, Math.max(0, project.tracks.screen.duration - 0.05));
                };
                video.onseeked = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 480;
                    canvas.height = Math.max(1, Math.round((480 * video.videoHeight) / Math.max(1, video.videoWidth)));
                    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
                    done();
                    canvas.toBlob(
                        (blob) => {
                            if (!blob) return reject(new Error('Could not make a thumbnail'));
                            api.saveThumbnail(project.id, blob).catch(() => {});
                            resolve(URL.createObjectURL(blob));
                        },
                        'image/jpeg',
                        0.8
                    );
                };
            })
    );
    posterQueue = job.catch(() => {});
    return job;
}

/** The recording's poster frame (thumb.jpg), made the first time it's needed. */
function Thumbnail({ project }: { project: Project }) {
    const [url, setUrl] = useState(() => fileUrl(project, 'thumb.jpg'));
    const [failed, setFailed] = useState(false);
    useEffect(
        () => () => {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        },
        [url]
    );
    if (failed) return <Film className='absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-subtle' />;
    return (
        <img
            src={url}
            alt=''
            draggable={false}
            className='absolute inset-0 h-full w-full object-contain'
            onError={() => {
                if (url.startsWith('blob:')) setFailed(true);
                else makePoster(project).then(setUrl, () => setFailed(true));
            }}
        />
    );
}

function TrackIcons({ project, className }: { project: Project; className?: string }) {
    const { tracks } = project;
    return (
        <span className={cx('flex gap-1 text-muted', className)}>
            {tracks.microphone && (
                <span title='Has microphone audio'>
                    <Mic className='h-3.5 w-3.5' />
                </span>
            )}
            {tracks.systemAudio && (
                <span title='Has system audio'>
                    <Volume2 className='h-3.5 w-3.5' />
                </span>
            )}
            {tracks.camera && (
                <span title='Has camera'>
                    <Camera className='h-3.5 w-3.5' />
                </span>
            )}
        </span>
    );
}

function RecordingCard({ project, onOpen, onDeleted }: { project: Project; onOpen: () => void; onDeleted: () => void }) {
    const SourceIcon = SOURCE_ICONS[project.source.type] ?? Monitor;
    return (
        <div className='group relative rounded-xl border border-line bg-panel shadow-sm transition-[border-color,transform,box-shadow] duration-200 focus-within:z-10 hover:z-10 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md'>
            <button onClick={onOpen} className='block w-full cursor-default text-left' title='Open in the editor'>
                <span className='relative block aspect-video w-full overflow-hidden rounded-t-[11px] bg-stage'>
                    <Thumbnail project={project} />
                    <span className='absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white'>{formatDuration(project.duration)}</span>
                    <TrackIcons project={project} className='absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-1 text-white' />
                </span>
                <span className='flex items-center gap-2.5 px-3 py-2.5 pr-20'>
                    <SourceIcon className='h-4 w-4 shrink-0 text-subtle' />
                    <span className='min-w-0'>
                        <span className='block truncate text-sm font-medium'>{project.source.name}</span>
                        <span className='block text-xs text-subtle' title={new Date(project.createdAt).toLocaleString()}>
                            {whenRecorded(project.createdAt)}
                        </span>
                    </span>
                </span>
            </button>
            <div className='absolute bottom-2 right-2'>
                <RecordingMenu project={project} onDeleted={onDeleted} />
            </div>
        </div>
    );
}

/** Show in Finder and Delete. Delete removes the recording straight away. */
function RecordingMenu({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
    const [deleting, setDeleting] = useState(false);
    const remove = async () => {
        setDeleting(true);
        try {
            await api.deleteRecording(project.id);
            onDeleted();
        } catch (error) {
            toast.error(errorMessage(error));
            setDeleting(false);
        }
    };
    return (
        <div className='flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100'>
            <IconButton
                label='Show in Finder'
                size='icon-sm'
                className='h-7 w-7'
                onClick={(e) => {
                    e.stopPropagation();
                    revealItemInDir(project.path);
                }}
            >
                <FolderOpen className='h-3.5 w-3.5' />
            </IconButton>
            <IconButton
                label='Delete recording'
                size='icon-sm'
                className='h-7 w-7 hover:bg-danger-soft hover:text-danger-fg'
                disabled={deleting}
                onClick={(e) => {
                    e.stopPropagation();
                    remove();
                }}
            >
                <Trash2 className='h-3.5 w-3.5' />
            </IconButton>
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
