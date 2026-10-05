import { useState, type ReactNode } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { AppWindow, Camera, Clock, Crop, Film, FolderOpen, Mic, Monitor, MousePointerClick, Pencil, Plus, Sparkles, Trash2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, fileUrl, formatDuration, type Project } from '../lib/api';
import { Button, Kbd, cx } from './ui';

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

/** The recordings, as cards or a table. A click selects one (details on the right); a double-click opens it. */
export function RecordingsList({
    recordings,
    view,
    selectedId,
    onSelect,
    onOpen,
}: {
    recordings: Project[];
    view: LibraryView;
    selectedId: string | null;
    onSelect: (project: Project) => void;
    onOpen: (project: Project) => void;
}) {
    if (view === 'table') {
        return (
            <div className='overflow-hidden rounded-xl border border-line bg-panel'>
                <table className='w-full table-fixed text-sm'>
                    <thead className='border-b border-line bg-panel-2 text-left text-[11px] font-semibold uppercase tracking-wider text-subtle'>
                        <tr>
                            <th className='w-[46%] px-3 py-2 font-semibold'>Recording</th>
                            <th className='px-3 py-2 font-semibold'>Recorded</th>
                            <th className='w-20 px-3 py-2 font-semibold'>Length</th>
                            <th className='w-24 px-3 py-2 font-semibold'>Tracks</th>
                        </tr>
                    </thead>
                    <tbody>
                        {recordings.map((project) => {
                            const SourceIcon = SOURCE_ICONS[project.source.type] ?? Monitor;
                            const selected = project.id === selectedId;
                            return (
                                <tr
                                    key={project.id}
                                    onClick={() => onSelect(project)}
                                    onDoubleClick={() => onOpen(project)}
                                    className={cx('cursor-default border-b border-line last:border-0', selected ? 'bg-accent/10' : 'hover:bg-panel-2')}
                                    title='Double-click to open in the editor'
                                >
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
                            <RecordingCard
                                key={project.id}
                                project={project}
                                selected={project.id === selectedId}
                                onSelect={() => onSelect(project)}
                                onOpen={() => onOpen(project)}
                            />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

/** The first frame of a recording, from its screen track. */
function Thumbnail({ project }: { project: Project }) {
    return (
        <video src={`${fileUrl(project, project.tracks.screen.file)}#t=0.5`} preload='metadata' muted className='absolute inset-0 h-full w-full object-contain' />
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

function RecordingCard({ project, selected, onSelect, onOpen }: { project: Project; selected: boolean; onSelect: () => void; onOpen: () => void }) {
    const SourceIcon = SOURCE_ICONS[project.source.type] ?? Monitor;
    return (
        <button
            onClick={onSelect}
            onDoubleClick={onOpen}
            className={cx(
                'group block w-full cursor-default overflow-hidden rounded-xl border bg-panel text-left shadow-sm transition-colors',
                selected ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-strong'
            )}
            title='Double-click to open in the editor'
        >
            <span className='relative block aspect-video w-full overflow-hidden bg-stage'>
                <Thumbnail project={project} />
                <span className='absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white'>{formatDuration(project.duration)}</span>
                <TrackIcons project={project} className='absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-1 text-white' />
            </span>
            <span className='flex items-center gap-3 px-3 py-2.5'>
                <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted'>
                    <SourceIcon className='h-4 w-4' />
                </span>
                <span className='min-w-0'>
                    <span className='block truncate text-sm font-medium'>{project.source.name}</span>
                    <span className='block text-xs text-subtle' title={new Date(project.createdAt).toLocaleString()}>
                        {whenRecorded(project.createdAt)}
                    </span>
                </span>
            </span>
        </button>
    );
}

const SOURCE_LABELS = { display: 'Whole screen', window: 'One window', area: 'Part of the screen' };

/** The selected recording: what's in it, and what to do with it. */
export function RecordingDetails({ project, onOpen, onDeleted }: { project: Project; onOpen: () => void; onDeleted: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const { tracks } = project;
    const SourceIcon = SOURCE_ICONS[project.source.type] ?? Monitor;
    const size = tracks.screen.width && tracks.screen.height ? `${tracks.screen.width} × ${tracks.screen.height}` : null;

    const remove = async () => {
        try {
            await api.deleteRecording(project.id);
            onDeleted();
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    const rows: [string, ReactNode][] = [
        ['Recorded', new Date(project.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })],
        ['Length', formatDuration(project.duration)],
        ['Source', SOURCE_LABELS[project.source.type] ?? project.source.type],
        ...(size ? ([['Size', `${size} px`]] as [string, ReactNode][]) : []),
        ['Microphone', tracks.microphone ? 'Recorded' : 'None'],
        ['Mac audio', tracks.systemAudio ? 'Recorded' : 'None'],
        ['Camera', tracks.camera ? 'Recorded' : 'None'],
    ];

    return (
        <div className='flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-sm'>
            <div className='min-h-0 flex-1 space-y-5 overflow-y-auto p-5'>
                <div className='flex items-start gap-3'>
                    <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted'>
                        <SourceIcon className='h-4 w-4' />
                    </span>
                    <div className='min-w-0'>
                        <h3 className='truncate font-serif text-lg font-medium tracking-tight' title={project.source.name}>
                            {project.source.name}
                        </h3>
                        <p className='text-xs text-subtle'>{whenRecorded(project.createdAt)}</p>
                    </div>
                </div>
                <dl className='divide-y divide-line rounded-xl border border-line text-sm'>
                    {rows.map(([label, value]) => (
                        <div key={label} className='flex items-center justify-between gap-4 px-3 py-2'>
                            <dt className='text-muted'>{label}</dt>
                            <dd className='truncate text-right'>{value}</dd>
                        </div>
                    ))}
                </dl>
            </div>
            <div className='space-y-2 border-t border-line p-4'>
                <Button variant='primary' className='w-full' onClick={onOpen}>
                    <Pencil className='h-4 w-4' /> Open in editor
                </Button>
                {confirming ? (
                    <div className='flex items-center gap-2 rounded-lg bg-danger-soft p-2 text-xs'>
                        <span className='flex-1 text-danger-fg'>Delete this recording and its edits for good?</span>
                        <Button size='sm' variant='danger' onClick={remove}>
                            Delete
                        </Button>
                        <Button size='sm' variant='ghost' onClick={() => setConfirming(false)}>
                            Keep
                        </Button>
                    </div>
                ) : (
                    <div className='grid grid-cols-2 gap-2'>
                        <Button size='sm' onClick={() => revealItemInDir(project.path)}>
                            <FolderOpen className='h-3.5 w-3.5' /> Show in Finder
                        </Button>
                        <Button size='sm' onClick={() => setConfirming(true)}>
                            <Trash2 className='h-3.5 w-3.5' /> Delete
                        </Button>
                    </div>
                )}
            </div>
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
