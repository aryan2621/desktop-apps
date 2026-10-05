import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import {
    Captions,
    Check,
    Cpu,
    Download,
    ExternalLink,
    FolderOpen,
    KeyRound,
    ListChecks,
    Loader2,
    LogOut,
    Monitor,
    Moon,
    Palette,
    Sun,
    Trash2,
    X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type AiModels, type CaptionModel, type CaptionProgress, type GoogleStatus } from '../lib/api';
import { useTheme, type ThemeChoice } from '../lib/theme';
import { Button, IconButton, Modal, ProgressBar, Segmented, cx } from './ui';

export type SettingsSection = 'general' | 'ai' | 'captions' | 'google';

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Palette className='h-4 w-4' /> },
    { id: 'ai', label: 'AI editing', icon: <Cpu className='h-4 w-4' /> },
    { id: 'captions', label: 'Captions', icon: <Captions className='h-4 w-4' /> },
    { id: 'google', label: 'Google', icon: <KeyRound className='h-4 w-4' /> },
];

const gb = (mb: number) => `${(mb / 1000).toFixed(1)} GB`;

/** Settings, shown over the window: theme, AI and caption models, and the Google client for uploads. */
export function SettingsDialog({
    initialSection = 'general',
    onClose,
    onRunSetup,
}: {
    initialSection?: SettingsSection;
    onClose: () => void;
    onRunSetup?: () => void;
}) {
    const [section, setSection] = useState<SettingsSection>(initialSection);

    return (
        <Modal onClose={onClose} className='flex h-[560px] max-w-[760px]'>
            <nav className='flex w-48 shrink-0 flex-col gap-1 border-r border-line bg-panel-2 p-3'>
                <span className='px-2 pb-3 pt-1 font-serif text-[17px] font-medium tracking-tight'>Settings</span>
                {SECTIONS.map((s) => (
                    <button
                        key={s.id}
                        onClick={() => setSection(s.id)}
                        className={cx(
                            'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                            section === s.id ? 'bg-raised font-medium text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg'
                        )}
                    >
                        {s.icon}
                        {s.label}
                    </button>
                ))}
            </nav>
            <div className='flex min-w-0 flex-1 flex-col'>
                <div className='flex items-center justify-between border-b border-line px-6 py-3.5'>
                    <h2 className='text-sm font-medium'>{SECTIONS.find((s) => s.id === section)?.label}</h2>
                    <IconButton label='Close settings' size='icon-sm' onClick={onClose}>
                        <X className='h-4 w-4' />
                    </IconButton>
                </div>
                <div className='min-h-0 flex-1 overflow-y-auto p-6'>
                    {section === 'general' && <General onRunSetup={onRunSetup} />}
                    {section === 'ai' && <AiModelsSection />}
                    {section === 'captions' && <CaptionsSection />}
                    {section === 'google' && <GoogleSection />}
                </div>
            </div>
        </Modal>
    );
}

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
    return (
        <div className='flex items-center justify-between gap-6 border-b border-line py-4 first:pt-0 last:border-0'>
            <div className='min-w-0 space-y-0.5'>
                <p className='text-sm font-medium'>{title}</p>
                {description && <p className='text-xs text-muted'>{description}</p>}
            </div>
            <div className='shrink-0'>{children}</div>
        </div>
    );
}

const Progress = ProgressBar;

function General({ onRunSetup }: { onRunSetup?: () => void }) {
    const { choice, setChoice } = useTheme();
    return (
        <div>
            <Row title='Appearance' description='Light, dark, or follow macOS.'>
                <div className='w-[260px]'>
                    <Segmented<ThemeChoice>
                        size='sm'
                        value={choice}
                        onChange={setChoice}
                        options={[
                            {
                                value: 'system',
                                label: 'System',
                                icon: <Monitor className='h-3.5 w-3.5' />,
                            },
                            {
                                value: 'light',
                                label: 'Light',
                                icon: <Sun className='h-3.5 w-3.5' />,
                            },
                            {
                                value: 'dark',
                                label: 'Dark',
                                icon: <Moon className='h-3.5 w-3.5' />,
                            },
                        ]}
                    />
                </div>
            </Row>
            <Row title='Recordings' description='Recordings and exports are saved in ~/Movies/Capturita.'>
                <Button size='sm' onClick={async () => openPath(await api.recordingsDir())}>
                    <FolderOpen className='h-3.5 w-3.5' /> Open folder
                </Button>
            </Row>
            {onRunSetup && (
                <Row title='Setup' description='Permissions (screen, microphone, camera) and the captions model.'>
                    <Button size='sm' onClick={onRunSetup}>
                        <ListChecks className='h-3.5 w-3.5' /> Run setup again
                    </Button>
                </Row>
            )}
        </div>
    );
}

function AiModelsSection() {
    const [state, setState] = useState<AiModels | null>(null);
    const [progress, setProgress] = useState<number | null>(null);

    const refresh = useCallback(() => {
        api.aiModels()
            .then(setState)
            .catch((error) => toast.error(errorMessage(error)));
    }, []);

    useEffect(() => {
        refresh();
        const unlisten = listen<number>('ai-progress', ({ payload }) => setProgress(payload));
        return () => {
            unlisten.then((u) => u());
        };
    }, [refresh]);

    const run = async (action: () => Promise<void>) => {
        try {
            await action();
        } catch (error) {
            const message = errorMessage(error);
            if (message !== 'Cancelled') toast.error(message);
        }
        refresh();
    };

    const download = async (id: string) => {
        setProgress(0);
        setState((s) => (s ? { ...s, downloading: id } : s));
        await run(() => api.downloadAiModel(id));
        setProgress(null);
    };

    if (!state) return null;
    return (
        <div className='space-y-4'>
            <p className='text-sm text-muted'>
                AI editing turns a request like “cut the part about pricing” into edits, with a model that runs on this Mac. Pick one and download it once. This
                Mac has {state.ramGb} GB of memory.
            </p>
            {state.models.map((m) => {
                const active = state.active === m.id;
                const downloading = state.downloading === m.id;
                const tooBig = m.minRamGb > state.ramGb;
                return (
                    <div key={m.id} className={cx('space-y-3 rounded-xl border p-4', active ? 'border-accent/60 bg-panel-2' : 'border-line')}>
                        <div className='flex items-start gap-3'>
                            <div className='min-w-0 flex-1 space-y-1'>
                                <p className='flex items-center gap-2 text-sm font-medium'>
                                    {m.name}
                                    {active && <span className='rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent'>In use</span>}
                                </p>
                                <p className='text-xs text-muted'>{m.note}</p>
                                <p className={cx('text-xs', tooBig ? 'text-warning-fg' : 'text-subtle')}>
                                    {gb(m.sizeMb)} download · needs {m.minRamGb} GB of memory
                                    {tooBig ? ', more than this Mac has' : ''}
                                </p>
                            </div>
                            <div className='flex shrink-0 items-center gap-1.5'>
                                {m.downloaded ? (
                                    <>
                                        {!active && (
                                            <Button size='sm' variant='primary' onClick={() => run(() => api.setAiModel(m.id))}>
                                                Use
                                            </Button>
                                        )}
                                        <IconButton
                                            label={`Delete ${m.name} (frees ${gb(m.sizeMb)})`}
                                            size='icon-sm'
                                            onClick={() => run(() => api.deleteAiModel(m.id))}
                                        >
                                            <Trash2 className='h-3.5 w-3.5' />
                                        </IconButton>
                                    </>
                                ) : downloading ? (
                                    <Button size='sm' variant='ghost' onClick={() => api.cancelAiDownload()}>
                                        <X className='h-3.5 w-3.5' /> Cancel
                                    </Button>
                                ) : (
                                    <Button
                                        size='sm'
                                        variant={active ? 'primary' : 'secondary'}
                                        disabled={state.downloading !== null}
                                        onClick={() => download(m.id)}
                                    >
                                        <Download className='h-3.5 w-3.5' /> Download
                                    </Button>
                                )}
                            </div>
                        </div>
                        {downloading && <Progress value={progress ?? 0} />}
                        {!m.downloaded && !downloading && !active && <p className='text-xs text-subtle'>Download it, then choose Use.</p>}
                    </div>
                );
            })}
        </div>
    );
}

function CaptionsSection() {
    const [models, setModels] = useState<CaptionModel[] | null>(null);
    /** The model being downloaded, and how far along it is. */
    const [downloading, setDownloading] = useState<{ id: string; progress: number } | null>(null);

    const refresh = useCallback(() => {
        api.captionModels()
            .then(setModels)
            .catch((error) => toast.error(errorMessage(error)));
    }, []);

    useEffect(() => {
        refresh();
        const unlisten = listen<CaptionProgress>('captions-progress', ({ payload }) => {
            if (payload.phase === 'download') setDownloading((d) => (d ? { ...d, progress: payload.progress } : d));
        });
        return () => {
            unlisten.then((u) => u());
        };
    }, [refresh]);

    const run = async (action: () => Promise<void>) => {
        try {
            await action();
        } catch (error) {
            const message = errorMessage(error);
            if (message !== 'Cancelled') toast.error(message);
        }
        refresh();
    };
    /** Use a model; download it first if it isn't here yet. */
    const use = (model: CaptionModel) =>
        run(async () => {
            if (!model.downloaded) {
                setDownloading({ id: model.id, progress: 0 });
                try {
                    await api.downloadCaptionModel(model.id);
                } finally {
                    setDownloading(null);
                }
            }
            await api.selectCaptionModel(model.id);
            toast.success(`Captions now use ${model.label}`);
        });

    if (!models) return null;
    return (
        <div className='space-y-4'>
            <p className='text-sm text-muted'>
                Captions are made on this Mac with Whisper; nothing is uploaded. Bigger models are more accurate (especially for Hindi, accents and mixed languages) but slower
                and larger. English-only models only caption English. AI editing uses the same model.
            </p>
            <div className='divide-y divide-line rounded-xl border border-line'>
                {models.map((model) => {
                    const busy = downloading?.id === model.id;
                    return (
                        <div key={model.id} className='space-y-2 p-3'>
                            <div className='flex items-center gap-3'>
                                <span
                                    className={cx(
                                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                                        model.selected ? 'bg-accent/15 text-accent' : model.downloaded ? 'bg-success-soft text-success-fg' : 'bg-raised text-muted'
                                    )}
                                >
                                    {model.selected || model.downloaded ? <Check className='h-4 w-4' /> : <Captions className='h-4 w-4' />}
                                </span>
                                <div className='min-w-0 flex-1'>
                                    <p className='flex items-center gap-2 text-sm font-medium'>
                                        {model.label}
                                        {model.selected && <span className='rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent'>In use</span>}
                                    </p>
                                    <p className='text-xs text-muted'>
                                        {model.sizeMb >= 1000 ? `${(model.sizeMb / 1000).toFixed(1)} GB` : `${model.sizeMb} MB`} · {model.note}
                                    </p>
                                </div>
                                {busy ? (
                                    <Button size='sm' variant='ghost' onClick={() => api.cancelTranscription()}>
                                        <X className='h-3.5 w-3.5' /> Cancel
                                    </Button>
                                ) : (
                                    <div className='flex shrink-0 items-center gap-1'>
                                        {!model.selected && (
                                            <Button size='sm' variant={model.downloaded ? 'secondary' : 'primary'} disabled={!!downloading} onClick={() => use(model)}>
                                                {model.downloaded ? (
                                                    'Use'
                                                ) : (
                                                    <>
                                                        <Download className='h-3.5 w-3.5' /> Download
                                                    </>
                                                )}
                                            </Button>
                                        )}
                                        {model.downloaded && (
                                            <IconButton label={`Delete ${model.label} (frees ${model.sizeMb} MB)`} size='icon-sm' disabled={!!downloading} onClick={() => run(() => api.deleteCaptionModel(model.id))}>
                                                <Trash2 className='h-3.5 w-3.5' />
                                            </IconButton>
                                        )}
                                    </div>
                                )}
                            </div>
                            {busy && <Progress value={downloading.progress} />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

const GUIDE_URL = 'https://github.com/aryan2621/desktop-apps/blob/main/capturita/docs/google-setup.md';

/** Uploads use the user's own Google Cloud client; the steps to make one live in the guide. */
export function GoogleSection() {
    const [status, setStatus] = useState<GoogleStatus | null>(null);
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [saving, setSaving] = useState(false);
    const [changing, setChanging] = useState(false);

    const refresh = useCallback(() => {
        api.googleStatus()
            .then(setStatus)
            .catch((error) => toast.error(errorMessage(error)));
    }, []);
    useEffect(refresh, [refresh]);

    const save = async () => {
        setSaving(true);
        try {
            await api.googleSaveClient(clientId, clientSecret);
            toast.success('Saved. You’ll sign in with Google on your first upload.');
            setClientId('');
            setClientSecret('');
            setChanging(false);
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setSaving(false);
            refresh();
        }
    };

    const act = async (action: () => Promise<void>) => {
        try {
            await action();
        } catch (error) {
            toast.error(errorMessage(error));
        }
        refresh();
    };

    if (!status) return null;
    const input = 'h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-sm outline-none focus:border-accent';
    return (
        <div className='space-y-5'>
            <p className='text-sm text-muted'>
                Uploads to YouTube and Drive use your own free Google Cloud project, so only your account and keys are used. Keys stay in this Mac's Keychain.{' '}
                <button className='inline-flex cursor-default items-center gap-0.5 text-fg underline' onClick={() => openUrl(GUIDE_URL)}>
                    Setup guide <ExternalLink className='h-3 w-3' />
                </button>
            </p>

            {status.configured && (
                <div className='flex items-center gap-3 rounded-xl border border-line p-4'>
                    <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success-fg'>
                        <Check className='h-4 w-4' />
                    </span>
                    <div className='min-w-0 flex-1'>
                        <p className='text-sm font-medium'>{status.account ? `Signed in as ${status.account.email}` : 'Ready to upload'}</p>
                        <p className='truncate text-xs text-muted'>
                            Client ID {status.clientIdPreview}
                            {status.account ? '' : ' · you sign in on your first upload'}
                        </p>
                    </div>
                    {status.account && (
                        <IconButton label='Sign out of Google' size='icon-sm' onClick={() => act(() => api.googleSignOut())}>
                            <LogOut className='h-3.5 w-3.5' />
                        </IconButton>
                    )}
                    <IconButton label='Remove the Client ID and Secret (also signs out)' size='icon-sm' onClick={() => act(() => api.googleRemoveClient())}>
                        <Trash2 className='h-3.5 w-3.5' />
                    </IconButton>
                </div>
            )}

            {status.configured && !changing ? (
                <button className='cursor-default text-xs text-muted underline hover:text-fg' onClick={() => setChanging(true)}>
                    Use a different Google project
                </button>
            ) : (
                <div className='space-y-3'>
                    <input
                        className={input}
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder='Client ID (ends in .apps.googleusercontent.com)'
                        aria-label='Client ID'
                        spellCheck={false}
                    />
                    <input
                        className={input}
                        type='password'
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        placeholder='Client Secret (starts with GOCSPX-)'
                        aria-label='Client Secret'
                    />
                    <div className='flex justify-end gap-2'>
                        {changing && (
                            <Button size='sm' variant='ghost' onClick={() => setChanging(false)}>
                                Cancel
                            </Button>
                        )}
                        <Button variant='primary' size='sm' disabled={saving || !clientId.trim() || !clientSecret.trim()} onClick={save}>
                            {saving && <Loader2 className='h-3.5 w-3.5 animate-spin' />} Save
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
