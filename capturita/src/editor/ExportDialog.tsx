import { useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { CheckCircle2, Cloud, Copy, Download, ExternalLink, FileVideo, FolderOpen, KeyRound, Loader2, LogOut, RotateCw, SquarePlay, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, formatDuration, GOOGLE_SCOPES, type CursorData, type Destination, type GoogleStatus, type Privacy, type Project } from '../lib/api';
import { Button, cx } from '../components/ui';
import { SettingsDialog } from '../components/SettingsDialog';
import { defaultExportName, ExportCancelled, exportSize, exportVideo, type ExportProgress, type ExportSettings, type Resolution } from './export';
import { totalDuration, type Edit } from './model';

const SETTINGS_KEY = 'capturita.export';
type Target = 'file' | Destination;

interface Remembered extends ExportSettings {
    target: Target;
    privacy: Privacy;
    /** Set once the user's Google project has passed YouTube's API audit. */
    youtubeAudited: boolean;
}

const YOUTUBE_STUDIO = 'https://studio.youtube.com/';

const RESOLUTIONS: { value: Resolution; label: string }[] = [
    { value: 720, label: '720p' },
    { value: 1080, label: '1080p' },
    { value: 2160, label: '4K' },
];
const TARGETS: { value: Target; label: string; hint: string; icon: ReactNode }[] = [
    { value: 'file', label: 'File', hint: 'Save an MP4 on this Mac', icon: <FileVideo className='h-4 w-4' /> },
    { value: 'youtube', label: 'YouTube', hint: 'Export, then upload to your YouTube channel', icon: <SquarePlay className='h-4 w-4' /> },
    { value: 'drive', label: 'Drive', hint: 'Export, then upload to your Google Drive', icon: <Cloud className='h-4 w-4' /> },
];
const PRIVACY: { value: Privacy; label: string }[] = [
    { value: 'private', label: 'Private' },
    { value: 'unlisted', label: 'Unlisted' },
    { value: 'public', label: 'Public' },
];
const PHASES: Record<ExportProgress['phase'], string> = {
    audio: 'Mixing audio…',
    video: 'Rendering video…',
    finishing: 'Finishing file…',
};

function loadSettings(): Remembered {
    const defaults: Remembered = { resolution: 1080, fps: 30, target: 'file', privacy: 'private', youtubeAudited: false };
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    } catch {
        return defaults;
    }
}

type State =
    | { status: 'idle' }
    | { status: 'exporting'; progress: ExportProgress }
    | { status: 'signing-in' }
    | { status: 'uploading'; path: string; sent: number; total: number }
    | { status: 'done'; path: string; url?: string; seconds: number; lockedPrivate?: boolean }
    | { status: 'error'; message: string; path?: string };

export function ExportDialog({ project, edit, cursor, onClose }: { project: Project; edit: Edit; cursor: CursorData | null; onClose: () => void }) {
    const [settings, setSettings] = useState<Remembered>(loadSettings);
    const [state, setState] = useState<State>({ status: 'idle' });
    const [google, setGoogle] = useState<GoogleStatus | null>(null);
    const [googleSettings, setGoogleSettings] = useState(false);
    const [title, setTitle] = useState(project.source.name);
    const [fileName, setFileName] = useState(() => defaultExportName(project));
    const [description, setDescription] = useState('');
    const abortRef = useRef<AbortController | null>(null);
    const startedAt = useRef(0);

    const size = exportSize(edit, project, settings.resolution);
    const uploading = settings.target !== 'file';
    const busy = state.status === 'exporting' || state.status === 'signing-in' || state.status === 'uploading';
    const needsSetup = uploading && google !== null && !google.configured;

    const refreshGoogle = () =>
        api
            .googleStatus()
            .then(setGoogle)
            .catch(() => {});
    useEffect(() => {
        refreshGoogle();
    }, []);

    useEffect(() => {
        const unlisten = listen<{ sent: number; total: number }>('upload-progress', ({ payload }) =>
            setState((current) => (current.status === 'uploading' ? { ...current, ...payload } : current))
        );
        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    const update = (change: Partial<Remembered>) => {
        const next = { ...settings, ...change };
        setSettings(next);
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch {
            // Settings just won't be remembered.
        }
    };

    /** Signs in (in the browser) if the account doesn't have this destination's permission yet. */
    const ensureSignedIn = async (destination: Destination) => {
        const status = await api.googleStatus();
        setGoogle(status);
        if (status.account?.scopes.includes(GOOGLE_SCOPES[destination])) return;
        setState({ status: 'signing-in' });
        await api.googleSignIn(destination);
        setGoogle(await api.googleStatus());
    };

    const upload = async (path: string, destination: Destination) => {
        try {
            await ensureSignedIn(destination);
            setState({ status: 'uploading', path, sent: 0, total: 1 });
            const result = await api.upload({
                destination,
                path,
                title: title.trim() || project.source.name,
                description,
                privacy: destination === 'youtube' ? settings.privacy : undefined,
            });
            setState({
                status: 'done',
                path,
                url: result.url,
                seconds: (performance.now() - startedAt.current) / 1000,
                lockedPrivate: destination === 'youtube' && settings.privacy !== 'private' && !settings.youtubeAudited,
            });
            toast.success(destination === 'youtube' ? 'Uploaded to YouTube' : 'Uploaded to Google Drive');
        } catch (error) {
            // The export itself succeeded, so keep the file and offer to retry the upload.
            setState({ status: 'error', message: errorMessage(error), path });
        }
    };

    /**
     * Unaudited Google projects can only upload private YouTube videos. "studio" exports the MP4
     * and opens YouTube Studio so the user can publish it publicly themselves.
     */
    const start = async (mode: 'default' | 'studio' = 'default') => {
        const controller = new AbortController();
        abortRef.current = controller;
        startedAt.current = performance.now();
        setState({ status: 'exporting', progress: { phase: 'audio', progress: 0 } });
        let path: string;
        try {
            path = await exportVideo({
                project,
                edit,
                cursor,
                settings,
                fileName,
                signal: controller.signal,
                onProgress: (progress) => setState({ status: 'exporting', progress }),
            });
        } catch (error) {
            setState(error instanceof ExportCancelled ? { status: 'idle' } : { status: 'error', message: errorMessage(error) });
            return;
        } finally {
            abortRef.current = null;
        }
        if (mode === 'studio') {
            setState({ status: 'done', path, seconds: (performance.now() - startedAt.current) / 1000 });
            revealItemInDir(path).catch(() => {});
            openUrl(YOUTUBE_STUDIO).catch(() => {});
            toast.success('Exported. Upload the MP4 in YouTube Studio to publish it publicly.');
        } else if (settings.target === 'file') {
            setState({ status: 'done', path, seconds: (performance.now() - startedAt.current) / 1000 });
            toast.success('Export finished');
        } else {
            await upload(path, settings.target);
        }
    };

    const cancel = () => {
        if (state.status === 'exporting') abortRef.current?.abort();
        if (state.status === 'uploading') api.cancelUpload();
    };

    const signOut = async () => {
        await api.googleSignOut();
        refreshGoogle();
        toast.success('Signed out of Google');
    };

    const close = () => {
        if (!busy) onClose();
    };

    return (
        <>
            <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm' onClick={close} data-export-busy={busy || undefined}>
                <div className='w-full max-w-md space-y-5 rounded-2xl border border-line bg-panel p-6 shadow-panel' onClick={(e) => e.stopPropagation()}>
                    <div className='flex items-center justify-between'>
                        <h2 className='flex items-center gap-2 font-serif text-lg font-medium'>
                            <Download className='h-4 w-4' /> Export
                        </h2>
                        <Button size='icon' variant='ghost' className='h-8 w-8' onClick={close} disabled={busy} title='Close' aria-label='Close'>
                            <X className='h-4 w-4' />
                        </Button>
                    </div>

                    {(state.status === 'idle' || (state.status === 'error' && !state.path)) && (
                        <>
                            <Group label='Save to'>
                                <div className='grid grid-cols-3 gap-1 rounded-lg bg-panel-2 p-1'>
                                    {TARGETS.map((target) => (
                                        <button
                                            key={target.value}
                                            onClick={() => update({ target: target.value })}
                                            className={cx(
                                                'flex h-9 items-center justify-center gap-1.5 rounded-md text-sm',
                                                settings.target === target.value ? 'bg-accent text-white' : 'text-muted hover:text-fg'
                                            )}
                                            title={target.hint}
                                        >
                                            {target.icon}
                                            {target.label}
                                        </button>
                                    ))}
                                </div>
                            </Group>

                            <Group label='File name'>
                                <div className='flex h-9 items-center rounded-lg border border-line bg-panel-2 focus-within:border-accent'>
                                    <input
                                        value={fileName}
                                        onChange={(e) => setFileName(e.target.value)}
                                        onFocus={(e) => e.target.select()}
                                        placeholder={defaultExportName(project)}
                                        className='h-full min-w-0 flex-1 bg-transparent px-3 text-sm outline-none'
                                        aria-label='File name'
                                        title='Saved in ~/Movies/Capturita/Exports. If the name is taken, a number is added.'
                                        spellCheck={false}
                                    />
                                    <span className='pr-3 font-mono text-xs text-muted'>.mp4</span>
                                </div>
                            </Group>

                            <div className='grid grid-cols-2 gap-3'>
                                <Group label='Resolution'>
                                    <Segment
                                        value={settings.resolution}
                                        options={RESOLUTIONS.map((r) => ({ value: r.value, label: r.label, hint: `Export at ${r.label}` }))}
                                        onChange={(resolution) => update({ resolution })}
                                    />
                                </Group>
                                <Group label='Frame rate'>
                                    <Segment
                                        value={settings.fps}
                                        options={[
                                            { value: 30 as const, label: '30', hint: 'Smaller file, fine for most screen recordings' },
                                            { value: 60 as const, label: '60', hint: 'Smoother motion, bigger file' },
                                        ]}
                                        onChange={(fps) => update({ fps })}
                                    />
                                </Group>
                            </div>

                            {uploading && (
                                <div className='space-y-3'>
                                    {needsSetup ? (
                                        <div className='space-y-3 rounded-lg border border-warning/30 bg-warning-soft p-3 text-xs'>
                                            <p className='font-medium text-warning-fg'>Connect Google first</p>
                                            <p className='text-muted'>
                                                Uploads use your own Google Cloud project. Add its Client ID and Client Secret in Settings; it takes a few minutes, once.
                                            </p>
                                            <Button size='sm' onClick={() => setGoogleSettings(true)}>
                                                <KeyRound className='h-3.5 w-3.5' /> Set up Google
                                            </Button>
                                        </div>
                                    ) : (
                                        <div className='flex items-center justify-between rounded-lg bg-panel-2 px-3 py-2 text-xs'>
                                            <span className='truncate text-muted'>
                                                {google?.account ? `Signed in as ${google.account.email}` : 'You’ll sign in with Google in your browser when the upload starts.'}
                                            </span>
                                            {google?.account && (
                                                <Button size='icon' variant='ghost' className='h-7 w-7 shrink-0' onClick={signOut} title='Sign out of Google' aria-label='Sign out of Google'>
                                                    <LogOut className='h-3.5 w-3.5' />
                                                </Button>
                                            )}
                                        </div>
                                    )}
                                    <input
                                        value={title}
                                        onChange={(e) => setTitle(e.target.value)}
                                        placeholder='Title'
                                        className='h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-sm outline-none focus:border-accent'
                                        aria-label='Title'
                                        title='Title'
                                    />
                                    <textarea
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        placeholder='Description (optional)'
                                        rows={2}
                                        className='w-full resize-none rounded-lg border border-line bg-panel-2 p-2 text-sm outline-none focus:border-accent'
                                        aria-label='Description'
                                        title='Description'
                                    />
                                    {settings.target === 'youtube' && (
                                        <Group label='Visibility'>
                                            <Segment value={settings.privacy} options={PRIVACY.map((p) => ({ ...p, hint: `${p.label} on YouTube` }))} onChange={(privacy) => update({ privacy })} />
                                            {settings.privacy !== 'private' && !settings.youtubeAudited ? (
                                                <div className='space-y-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-xs'>
                                                    <p className='text-warning-fg'>
                                                        Until Google audits your API project, YouTube locks videos uploaded from apps to <b>private</b>, even when you pick{' '}
                                                        {settings.privacy}. To publish now, export the MP4 and upload it in YouTube Studio.
                                                    </p>
                                                    <div className='flex flex-wrap items-center gap-2'>
                                                        <Button size='sm' variant='secondary' onClick={() => start('studio')} title='Export the MP4, show it in Finder and open YouTube Studio'>
                                                            <ExternalLink className='h-3.5 w-3.5' /> Export & open YouTube Studio
                                                        </Button>
                                                        <Button size='sm' variant='ghost' onClick={() => update({ youtubeAudited: true })} title='Hide this note: my project passed the YouTube API audit'>
                                                            My project is audited
                                                        </Button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <p className='text-xs text-muted'>
                                                    {settings.youtubeAudited ? 'Uploads use the visibility you choose.' : 'Private videos are only visible to you.'}
                                                </p>
                                            )}
                                        </Group>
                                    )}
                                </div>
                            )}

                            <p className='text-xs text-muted'>
                                {size.width} × {size.height} · {formatDuration(totalDuration(edit.clips))} · saved to Movies › Capturita › Exports
                            </p>
                            {state.status === 'error' && <p className='rounded-lg bg-danger-soft p-3 text-xs text-danger-fg'>Export failed: {state.message}</p>}
                            <Button variant='primary' className='w-full' onClick={() => start()} disabled={needsSetup} title={needsSetup ? 'Connect Google first' : undefined}>
                                <Download className='h-4 w-4' /> {uploading ? 'Export & upload' : 'Export'}
                            </Button>
                        </>
                    )}

                    {state.status === 'exporting' && (
                        <Progress label={PHASES[state.progress.phase]} value={state.progress.progress} onCancel={cancel} cancelLabel='Cancel export' />
                    )}

                    {state.status === 'signing-in' && (
                        <div className='flex items-center gap-3 rounded-lg bg-panel-2 p-3 text-sm'>
                            <Loader2 className='h-4 w-4 shrink-0 animate-spin' />
                            <span>Finish signing in with Google in your browser…</span>
                        </div>
                    )}

                    {state.status === 'uploading' && (
                        <Progress
                            label={`Uploading to ${settings.target === 'youtube' ? 'YouTube' : 'Google Drive'}… ${formatBytes(state.sent)} of ${formatBytes(state.total)}`}
                            value={state.sent / Math.max(1, state.total)}
                            onCancel={cancel}
                            cancelLabel='Cancel upload'
                        />
                    )}

                    {state.status === 'error' && state.path && (
                        <div className='space-y-3'>
                            <p className='rounded-lg bg-danger-soft p-3 text-xs text-danger-fg'>Upload failed: {state.message}</p>
                            <p className='text-xs text-muted'>The MP4 was exported and is still saved on this Mac.</p>
                            <div className='flex justify-end gap-2'>
                                <Button size='icon' variant='secondary' onClick={() => revealItemInDir(state.path!)} title='Show the MP4 in Finder' aria-label='Show in Finder'>
                                    <FolderOpen className='h-4 w-4' />
                                </Button>
                                <Button
                                    size='icon'
                                    variant='primary'
                                    onClick={() => settings.target !== 'file' && upload(state.path!, settings.target)}
                                    title='Retry the upload'
                                    aria-label='Retry the upload'
                                >
                                    <RotateCw className='h-4 w-4' />
                                </Button>
                            </div>
                        </div>
                    )}

                    {state.status === 'done' && (
                        <div className='space-y-4'>
                            <div className='flex items-start gap-3 rounded-lg bg-success-soft p-3'>
                                <CheckCircle2 className='mt-0.5 h-5 w-5 shrink-0 text-success' />
                                <div className='min-w-0 text-sm'>
                                    <p className='font-medium'>{state.url ? 'Uploaded' : 'Saved'}</p>
                                    <p className='truncate text-xs text-muted'>{state.url ?? state.path.split('/').pop()}</p>
                                    <p className='text-xs text-muted'>Took {formatDuration(state.seconds)}</p>
                                    {state.lockedPrivate && (
                                        <p className='pt-1 text-xs text-warning-fg'>YouTube kept it private because your API project isn't audited yet. Upload the MP4 in YouTube Studio to make it public.</p>
                                    )}
                                </div>
                            </div>
                            <div className='flex justify-end gap-2'>
                                {state.url && (
                                    <>
                                        <Button size='icon' variant='primary' onClick={() => openUrl(state.url!)} title='Open in the browser' aria-label='Open in the browser'>
                                            <ExternalLink className='h-4 w-4' />
                                        </Button>
                                        <Button
                                            size='icon'
                                            variant='secondary'
                                            onClick={() =>
                                                navigator.clipboard
                                                    .writeText(state.url!)
                                                    .then(() => toast.success('Link copied'))
                                                    .catch(() => toast.error('Could not copy the link'))
                                            }
                                            title='Copy link'
                                            aria-label='Copy link'
                                        >
                                            <Copy className='h-4 w-4' />
                                        </Button>
                                    </>
                                )}
                                <Button size='icon' variant='secondary' onClick={() => revealItemInDir(state.path)} title='Show the MP4 in Finder' aria-label='Show in Finder'>
                                    <FolderOpen className='h-4 w-4' />
                                </Button>
                                <Button size='icon' variant='ghost' onClick={() => setState({ status: 'idle' })} title='Export again with other settings' aria-label='Export again'>
                                    <Download className='h-4 w-4' />
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {googleSettings && (
                <SettingsDialog
                    initialSection='google'
                    onClose={() => {
                        setGoogleSettings(false);
                        refreshGoogle();
                    }}
                />
            )}
        </>
    );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className='space-y-2'>
            <p className='text-xs font-medium uppercase tracking-wide text-muted'>{label}</p>
            {children}
        </div>
    );
}

function Segment<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string; hint: string }[]; onChange: (value: T) => void }) {
    return (
        <div className='grid gap-1 rounded-lg bg-panel-2 p-1' style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
            {options.map((option) => (
                <button
                    key={option.value}
                    onClick={() => onChange(option.value)}
                    className={cx('h-8 rounded-md text-sm', value === option.value ? 'bg-accent text-white' : 'text-muted hover:text-fg')}
                    title={option.hint}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

function Progress({ label, value, onCancel, cancelLabel }: { label: string; value: number; onCancel: () => void; cancelLabel: string }) {
    return (
        <div className='space-y-3'>
            <div className='flex items-center justify-between gap-3 text-sm'>
                <span className='flex min-w-0 items-center gap-2'>
                    <Loader2 className='h-4 w-4 shrink-0 animate-spin' />
                    <span className='truncate'>{label}</span>
                </span>
                <span className='font-mono text-muted'>{Math.round(value * 100)}%</span>
            </div>
            <div className='h-2 overflow-hidden rounded-full bg-panel-2'>
                <div className='h-full rounded-full bg-accent transition-[width]' style={{ width: `${value * 100}%` }} />
            </div>
            <div className='flex justify-end'>
                <Button size='icon' variant='ghost' className='h-8 w-8' onClick={onCancel} title={cancelLabel} aria-label={cancelLabel}>
                    <X className='h-4 w-4' />
                </Button>
            </div>
        </div>
    );
}

function formatBytes(bytes: number) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
