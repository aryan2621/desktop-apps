import { useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { ArrowLeft, CheckCircle2, ChevronDown, Clipboard, Cloud, Copy, Download, ExternalLink, FileVideo, FolderOpen, KeyRound, Loader2, LogOut, RotateCw, SquarePlay, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, formatDuration, GOOGLE_SCOPES, type CursorData, type Destination, type GoogleStatus, type Privacy, type Project } from '../lib/api';
import { Button, Modal, ProgressBar, Segmented, cx } from '../components/ui';
import { GoogleSection } from '../components/SettingsDialog';
import { defaultExportName, ExportCancelled, exportSize, exportVideo, type ExportProgress, type ExportSettings, type Quality, type Resolution } from './export';
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
    { value: 480, label: '480p' },
    { value: 720, label: '720p' },
    { value: 1080, label: '1080p' },
    { value: 2160, label: '4K' },
];

type PresetId = 'studio' | 'web' | 'social' | 'small' | 'gif';
/** One-click export settings, like Screen Studio's presets. */
const PRESETS: { id: PresetId; label: string; hint: string; settings: ExportSettings }[] = [
    { id: 'web', label: 'Web', hint: '1080p · 30 fps · good for docs, Slack and the web', settings: { format: 'mp4', resolution: 1080, fps: 30, quality: 'high' } },
    { id: 'studio', label: 'Studio', hint: '4K · 60 fps · highest quality, big file', settings: { format: 'mp4', resolution: 2160, fps: 60, quality: 'studio' } },
    { id: 'social', label: 'Social', hint: '1080p · 60 fps · smooth for social posts', settings: { format: 'mp4', resolution: 1080, fps: 60, quality: 'high' } },
    { id: 'small', label: 'Small', hint: '720p · 30 fps · smallest MP4', settings: { format: 'mp4', resolution: 720, fps: 30, quality: 'medium' } },
    { id: 'gif', label: 'GIF', hint: '480p · 15 fps · silent, loops; best under a minute', settings: { format: 'gif', resolution: 480, fps: 15, quality: 'high' } },
];
const QUALITIES: { value: Quality; label: string; hint: string }[] = [
    { value: 'small', label: 'Low', hint: 'Smallest file' },
    { value: 'medium', label: 'Medium', hint: 'Balanced' },
    { value: 'high', label: 'High', hint: 'Sharp text, reasonable size' },
    { value: 'studio', label: 'Best', hint: 'Highest bitrate' },
];
const samePreset = (a: ExportSettings, b: ExportSettings) => a.format === b.format && a.resolution === b.resolution && a.fps === b.fps && a.quality === b.quality;
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
    const defaults: Remembered = { ...PRESETS[0].settings, target: 'file', privacy: 'private', youtubeAudited: false };
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
    const [connecting, setConnecting] = useState(false);
    const [advanced, setAdvanced] = useState(false);
    const [title, setTitle] = useState(project.source.name);
    const [fileName, setFileName] = useState(() => defaultExportName(project));
    const [description, setDescription] = useState('');
    const abortRef = useRef<AbortController | null>(null);
    const startedAt = useRef(0);

    const size = exportSize(edit, project, settings.resolution);
    const gif = settings.format === 'gif';
    const uploading = settings.target !== 'file' && !gif;
    const preset = PRESETS.find((p) => samePreset(p.settings, settings))?.id ?? null;
    const extension = gif ? '.gif' : '.mp4';
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
        } else if (settings.target === 'file' || gif) {
            setState({ status: 'done', path, seconds: (performance.now() - startedAt.current) / 1000 });
            toast.success('Export finished');
        } else {
            await upload(path, settings.target as Destination);
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

    const copyFile = (path: string) =>
        api
            .copyFileToClipboard(path)
            .then(() => toast.success(`${gif ? 'GIF' : 'Video'} copied — paste it anywhere`))
            .catch((error) => toast.error(errorMessage(error)));

    if (connecting) {
        return (
            <Modal onClose={() => setConnecting(false)} className='flex max-h-[640px] max-w-lg flex-col'>
                <div className='flex items-center gap-2 border-b border-line px-4 py-3'>
                    <Button
                        size='icon-sm'
                        variant='ghost'
                        onClick={() => {
                            setConnecting(false);
                            refreshGoogle();
                        }}
                        title='Back to export'
                        aria-label='Back to export'
                    >
                        <ArrowLeft className='h-4 w-4' />
                    </Button>
                    <h2 className='text-sm font-medium'>Connect Google</h2>
                </div>
                <div className='min-h-0 flex-1 overflow-y-auto p-6'>
                    <GoogleSection />
                </div>
                <div className='flex justify-end border-t border-line px-4 py-3'>
                    <Button
                        variant='primary'
                        onClick={() => {
                            setConnecting(false);
                            refreshGoogle();
                        }}
                    >
                        Done
                    </Button>
                </div>
            </Modal>
        );
    }

    return (
        <Modal onClose={close} dismissable={!busy} className='max-w-md' data-export-busy={busy || undefined}>
                <div className='max-h-[85vh] space-y-5 overflow-y-auto p-6'>
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
                                            disabled={gif && target.value !== 'file'}
                                            className={cx(
                                                'flex h-9 items-center justify-center gap-1.5 rounded-md text-sm disabled:opacity-40',
                                                (gif ? 'file' : settings.target) === target.value ? 'bg-accent text-white' : 'text-muted hover:text-fg'
                                            )}
                                            title={gif && target.value !== 'file' ? 'GIFs are saved as files' : target.hint}
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
                                    <span className='pr-3 font-mono text-xs text-muted'>{extension}</span>
                                </div>
                            </Group>

                            <Group label='Preset'>
                                <div className='grid grid-cols-5 gap-1.5'>
                                    {PRESETS.map((p) => (
                                        <button
                                            key={p.id}
                                            onClick={() => update(p.settings)}
                                            className={cx(
                                                'flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg border text-xs transition-colors',
                                                preset === p.id ? 'border-accent bg-accent/10 text-fg' : 'border-line bg-panel-2 text-muted hover:border-line-strong hover:text-fg'
                                            )}
                                            title={p.hint}
                                        >
                                            <span className='text-sm font-medium'>{p.label}</span>
                                            <span className='font-mono text-[10px] text-subtle'>
                                                {p.settings.resolution === 2160 ? '4K' : `${p.settings.resolution}p`}
                                                {p.settings.fps}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                <button className='flex items-center gap-1 text-xs text-muted hover:text-fg' onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
                                    <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', advanced && 'rotate-180')} />
                                    {preset ? 'Customize' : 'Custom settings'}
                                </button>
                            </Group>

                            {(advanced || !preset) && (
                                <div className='space-y-3 rounded-lg border border-line p-3'>
                                    <Group label='Format'>
                                        <Segmented
                                            size='sm'
                                            value={settings.format}
                                            onChange={(format) => update(format === 'gif' ? { format, fps: 15, resolution: Math.min(settings.resolution, 720) as Resolution } : { format, fps: settings.fps === 15 ? 30 : settings.fps })}
                                            options={[
                                                { value: 'mp4', label: 'MP4', hint: 'Video with sound' },
                                                { value: 'gif', label: 'GIF', hint: 'Silent, loops, plays anywhere' },
                                            ]}
                                        />
                                    </Group>
                                    <Group label='Resolution'>
                                        <Segmented
                                            size='sm'
                                            value={settings.resolution}
                                            onChange={(resolution) => update({ resolution })}
                                            options={RESOLUTIONS.filter((r) => !gif || r.value <= 720).map((r) => ({ value: r.value, label: r.label, hint: `Export at ${r.label}` }))}
                                        />
                                    </Group>
                                    <Group label='Frame rate'>
                                        <Segmented
                                            size='sm'
                                            value={settings.fps}
                                            onChange={(fps) => update({ fps })}
                                            options={(gif ? ([10, 15, 24] as const) : ([24, 30, 60] as const)).map((fps) => ({ value: fps as ExportSettings['fps'], label: `${fps} fps` }))}
                                        />
                                    </Group>
                                    {!gif && (
                                        <Group label='Quality'>
                                            <Segmented size='sm' value={settings.quality} onChange={(quality) => update({ quality })} options={QUALITIES} />
                                        </Group>
                                    )}
                                </div>
                            )}

                            {uploading && (
                                <div className='space-y-3'>
                                    {needsSetup ? (
                                        <div className='space-y-3 rounded-lg border border-warning/30 bg-warning-soft p-3 text-xs'>
                                            <p className='font-medium text-warning-fg'>Connect Google first</p>
                                            <p className='text-muted'>
                                                Uploads use your own Google Cloud project. Add its Client ID and Client Secret in Settings; it takes a few minutes, once.
                                            </p>
                                            <Button size='sm' onClick={() => setConnecting(true)}>
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
                                            <Segmented size='sm' value={settings.privacy} options={PRIVACY.map((p) => ({ ...p, hint: `${p.label} on YouTube` }))} onChange={(privacy: Privacy) => update({ privacy })} />
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
                                {gif ? 'GIF' : 'MP4'} · {size.width} × {size.height} · {settings.fps} fps · {formatDuration(totalDuration(edit.clips))}
                                {gif && totalDuration(edit.clips) > 60 ? ' · long GIFs get very large' : ''} · saved to Movies › Capturita › Exports
                            </p>
                            {state.status === 'error' && <p className='rounded-lg bg-danger-soft p-3 text-xs text-danger-fg'>Export failed: {state.message}</p>}
                            <Button variant='primary' className='w-full' onClick={() => start()} disabled={needsSetup} title={needsSetup ? 'Connect Google first' : undefined}>
                                <Download className='h-4 w-4' /> {uploading ? 'Export & upload' : gif ? 'Export GIF' : 'Export'}
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
                                <Button variant='secondary' onClick={() => copyFile(state.path)} title='Copy the file, then paste it into Slack, Mail or Finder'>
                                    <Clipboard className='h-4 w-4' /> Copy
                                </Button>
                                <Button size='icon' variant='secondary' onClick={() => revealItemInDir(state.path)} title='Show in Finder' aria-label='Show in Finder'>
                                    <FolderOpen className='h-4 w-4' />
                                </Button>
                                <Button size='icon' variant='ghost' onClick={() => setState({ status: 'idle' })} title='Export again with other settings' aria-label='Export again'>
                                    <Download className='h-4 w-4' />
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
        </Modal>
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

function Progress({ label, value, onCancel, cancelLabel }: { label: string; value: number; onCancel: () => void; cancelLabel: string }) {
    return (
        <div className='space-y-3'>
            <div className='flex items-center gap-2 text-sm'>
                <Loader2 className='h-4 w-4 shrink-0 animate-spin' />
                <span className='truncate'>{label}</span>
            </div>
            <ProgressBar value={value} />
            <div className='flex justify-end'>
                <Button size='sm' variant='ghost' onClick={onCancel} title={cancelLabel}>
                    <X className='h-3.5 w-3.5' /> Cancel
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
