import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowRight, Camera, Captions, Check, Download, Keyboard, Mic, MonitorUp, RotateCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type CaptionProgress, type PermissionKind, type Permissions } from '../lib/api';
import { finishSetup, setResumeStep, SETUP_STEPS, type SetupStep } from '../lib/setup';
import { Button, Kbd, cx } from './ui';

/** How often permissions are re-checked while that step is open (changes happen in System Settings). */
const POLL_MS = 1500;

/**
 * First-run setup, shown over the main window: what Capturita does, the permissions it needs,
 * the optional caption model, and how to start recording. Can be reopened from the header.
 */
export function SetupFlow({ initialStep, onClose, onPermissionsChange }: { initialStep: SetupStep; onClose: () => void; onPermissionsChange: (p: Permissions) => void }) {
    const [step, setStep] = useState<SetupStep>(initialStep);
    const index = SETUP_STEPS.indexOf(step);
    const next = () => setStep(SETUP_STEPS[Math.min(SETUP_STEPS.length - 1, index + 1)]);
    const close = () => {
        finishSetup();
        onClose();
    };

    return (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm'>
            <div className='flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow-lg)]'>
                <div className='flex items-center gap-3 border-b border-line px-6 py-4'>
                    <span className='flex h-7 w-7 items-center justify-center rounded-lg bg-accent shadow-sm'>
                        <span className='h-2.5 w-2.5 rounded-full bg-white' />
                    </span>
                    <span className='font-serif text-[17px] font-medium tracking-tight'>Set up Capturita</span>
                    <div className='ml-auto flex items-center gap-1.5' aria-label={`Step ${index + 1} of ${SETUP_STEPS.length}`}>
                        {SETUP_STEPS.map((s, i) => (
                            <span key={s} className={cx('h-1.5 rounded-full transition-all', i === index ? 'w-5 bg-accent' : i < index ? 'w-1.5 bg-accent/60' : 'w-1.5 bg-line-strong')} />
                        ))}
                    </div>
                    {step !== 'done' && (
                        <button className='ml-3 text-xs text-muted hover:text-fg' onClick={close} title='Skip setup; you can open it again from the header'>
                            Skip setup
                        </button>
                    )}
                </div>
                <div className='overflow-y-auto p-6'>
                    {step === 'welcome' && <Welcome onNext={next} />}
                    {step === 'permissions' && <PermissionsStep onNext={next} onPermissionsChange={onPermissionsChange} />}
                    {step === 'captions' && <CaptionsStep onNext={next} />}
                    {step === 'done' && <Done onFinish={close} />}
                </div>
            </div>
        </div>
    );
}

function Welcome({ onNext }: { onNext: () => void }) {
    return (
        <div className='space-y-5'>
            <div className='space-y-2'>
                <h2 className='font-serif text-2xl font-medium tracking-tight'>Welcome to Capturita</h2>
                <p className='text-sm text-muted'>
                    Record your screen, camera and voice, then polish it here: zooms, captions, hidden private info, and export to MP4 or YouTube.
                </p>
            </div>
            <p className='text-sm text-muted'>Setup takes about a minute: a few permissions, and an optional download for captions.</p>
            <div className='flex justify-end'>
                <Button variant='primary' onClick={onNext}>
                    Get started <ArrowRight className='h-4 w-4' />
                </Button>
            </div>
        </div>
    );
}

function PermissionsStep({ onNext, onPermissionsChange }: { onNext: () => void; onPermissionsChange: (p: Permissions) => void }) {
    const [permissions, setPermissions] = useState<Permissions | null>(null);
    const [skipped, setSkipped] = useState<Set<PermissionKind>>(new Set());
    /** Screen access was requested in this session, so a restart is the next thing to do. */
    const [asked, setAsked] = useState(false);

    const refresh = useCallback(() => {
        api.permissions()
            .then((p) => {
                setPermissions(p);
                onPermissionsChange(p);
            })
            .catch(() => {});
    }, [onPermissionsChange]);

    useEffect(() => {
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => focused && refresh());
        return () => {
            clearInterval(timer);
            unlisten.then((u) => u());
        };
    }, [refresh]);

    const request = async (kind: PermissionKind) => {
        try {
            const p = await api.requestPermission(kind);
            setPermissions(p);
            onPermissionsChange(p);
            if (kind === 'screen') setAsked(true);
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    // Come back to this step after the restart, where macOS finally reports the new access.
    const restart = () => {
        setResumeStep('permissions');
        api.restart();
    };

    const screen = permissions?.screen === 'granted';
    const optional = (kind: 'microphone' | 'camera') => permissions?.[kind] === 'granted' || skipped.has(kind);

    return (
        <div className='space-y-5'>
            <div className='space-y-1'>
                <h2 className='font-serif text-xl font-medium tracking-tight'>Permissions</h2>
                <p className='text-sm text-muted'>macOS asks before any app can see your screen or use the mic and camera.</p>
            </div>
            <div className='space-y-2'>
                <PermissionRow
                    icon={<MonitorUp className='h-4 w-4' />}
                    title='Screen & system audio'
                    hint={
                        screen
                            ? 'Allowed.'
                            : asked
                              ? 'Turn on Capturita in System Settings → Privacy & Security → Screen & System Audio Recording, then restart. If it was already on, remove it with − and allow it again.'
                              : 'Required to record. macOS will open System Settings.'
                    }
                    state={screen ? 'granted' : 'missing'}
                    actions={
                        screen ? null : asked ? (
                            <Button size='sm' variant='primary' onClick={restart} title='Restart Capturita so macOS applies the permission'>
                                <RotateCw className='h-3.5 w-3.5' /> Restart
                            </Button>
                        ) : (
                            <Button size='sm' variant='primary' onClick={() => request('screen')}>
                                Allow
                            </Button>
                        )
                    }
                />
                {(['microphone', 'camera'] as const).map((kind) => {
                    const granted = permissions?.[kind] === 'granted';
                    const denied = permissions?.[kind] === 'denied';
                    return (
                        <PermissionRow
                            key={kind}
                            icon={kind === 'microphone' ? <Mic className='h-4 w-4' /> : <Camera className='h-4 w-4' />}
                            title={kind === 'microphone' ? 'Microphone' : 'Camera'}
                            hint={
                                granted
                                    ? 'Allowed.'
                                    : skipped.has(kind)
                                      ? 'Skipped. Capturita will ask the first time you use it.'
                                      : denied
                                        ? `Turned off. Turn on Capturita in System Settings → Privacy & Security → ${kind === 'microphone' ? 'Microphone' : 'Camera'}.`
                                        : kind === 'microphone'
                                          ? 'Optional: record your voice.'
                                          : 'Optional: show yourself in a bubble.'
                            }
                            state={granted ? 'granted' : skipped.has(kind) ? 'skipped' : 'missing'}
                            actions={
                                granted || skipped.has(kind) ? null : (
                                    <>
                                        <Button size='sm' variant='ghost' onClick={() => setSkipped(new Set(skipped).add(kind))}>
                                            Skip
                                        </Button>
                                        {!denied && (
                                            <Button size='sm' onClick={() => request(kind)}>
                                                Allow
                                            </Button>
                                        )}
                                    </>
                                )
                            }
                        />
                    );
                })}
            </div>
            <div className='flex items-center justify-end gap-3'>
                {!screen && <span className='text-xs text-subtle'>Screen recording is needed to continue.</span>}
                <Button variant='primary' onClick={onNext} disabled={!screen || !optional('microphone') || !optional('camera')}>
                    Continue <ArrowRight className='h-4 w-4' />
                </Button>
            </div>
        </div>
    );
}

function PermissionRow({ icon, title, hint, state, actions }: { icon: ReactNode; title: string; hint: string; state: 'granted' | 'skipped' | 'missing'; actions: ReactNode }) {
    return (
        <div className='flex items-start gap-3 rounded-xl border border-line bg-panel-2 p-3'>
            <span
                className={cx(
                    'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    state === 'granted' ? 'bg-success-soft text-success-fg' : 'bg-raised text-muted'
                )}
            >
                {state === 'granted' ? <Check className='h-4 w-4' /> : icon}
            </span>
            <div className='min-w-0 flex-1'>
                <p className='text-sm font-medium'>{title}</p>
                <p className='text-xs text-muted'>{hint}</p>
            </div>
            {actions && <div className='flex shrink-0 items-center gap-1.5'>{actions}</div>}
        </div>
    );
}

function CaptionsStep({ onNext }: { onNext: () => void }) {
    const [model, setModel] = useState<{ downloaded: boolean; sizeMb: number } | null>(null);
    const [progress, setProgress] = useState<number | null>(null);

    useEffect(() => {
        api.captionModel()
            .then(setModel)
            .catch(() => setModel({ downloaded: false, sizeMb: 547 }));
        const unlisten = listen<CaptionProgress>('captions-progress', ({ payload }) => {
            if (payload.phase === 'download') setProgress(payload.progress);
        });
        return () => {
            unlisten.then((u) => u());
        };
    }, []);

    const download = async () => {
        setProgress(0);
        try {
            await api.downloadCaptionModel();
            setModel((m) => (m ? { ...m, downloaded: true } : m));
        } catch (error) {
            const message = errorMessage(error);
            if (message !== 'Cancelled') toast.error(message);
        } finally {
            setProgress(null);
        }
    };

    const downloaded = model?.downloaded;
    return (
        <div className='space-y-5'>
            <div className='space-y-1'>
                <h2 className='font-serif text-xl font-medium tracking-tight'>Captions</h2>
                <p className='text-sm text-muted'>
                    Capturita turns what you say into captions on this Mac, so nothing is uploaded. It needs a speech model ({model?.sizeMb ?? 547} MB), downloaded once.
                </p>
            </div>
            <div className='flex items-center gap-3 rounded-xl border border-line bg-panel-2 p-3'>
                <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', downloaded ? 'bg-success-soft text-success-fg' : 'bg-raised text-muted')}>
                    {downloaded ? <Check className='h-4 w-4' /> : <Captions className='h-4 w-4' />}
                </span>
                <div className='min-w-0 flex-1 space-y-1.5'>
                    <p className='text-sm font-medium'>{downloaded ? 'Speech model ready' : progress !== null ? 'Downloading the speech model…' : 'Speech model'}</p>
                    {progress !== null ? (
                        <div className='flex items-center gap-2'>
                            <div className='h-1.5 flex-1 overflow-hidden rounded-full bg-line'>
                                <div className='h-full bg-accent transition-[width]' style={{ width: `${Math.round(progress * 100)}%` }} />
                            </div>
                            <span className='w-9 text-right font-mono text-xs text-muted'>{Math.round(progress * 100)}%</span>
                        </div>
                    ) : (
                        <p className='text-xs text-muted'>{downloaded ? 'Captions work offline.' : 'You can also skip this; it downloads the first time you make captions.'}</p>
                    )}
                </div>
                {!downloaded &&
                    model &&
                    (progress !== null ? (
                        <Button size='sm' variant='ghost' onClick={() => api.cancelTranscription()}>
                            <X className='h-3.5 w-3.5' /> Cancel
                        </Button>
                    ) : (
                        <Button size='sm' variant='primary' onClick={download}>
                            <Download className='h-3.5 w-3.5' /> Download
                        </Button>
                    ))}
            </div>
            <div className='flex items-center justify-end gap-2'>
                {!downloaded && progress === null && (
                    <Button variant='ghost' onClick={onNext}>
                        Skip for now
                    </Button>
                )}
                <Button variant='primary' onClick={onNext} disabled={progress !== null || !downloaded}>
                    Continue <ArrowRight className='h-4 w-4' />
                </Button>
            </div>
        </div>
    );
}

function Done({ onFinish }: { onFinish: () => void }) {
    return (
        <div className='space-y-5'>
            <div className='space-y-1'>
                <h2 className='font-serif text-xl font-medium tracking-tight'>You're all set</h2>
                <p className='text-sm text-muted'>Pick a screen, window or area on the left and press Record.</p>
            </div>
            <div className='flex items-center gap-3 rounded-xl border border-line bg-panel-2 p-3 text-sm'>
                <Keyboard className='h-4 w-4 shrink-0 text-muted' />
                <span>
                    Press <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>R</Kbd> from any app to start and stop recording.
                </span>
            </div>
            <div className='flex justify-end'>
                <Button variant='primary' onClick={onFinish}>
                    Start recording
                </Button>
            </div>
        </div>
    );
}
