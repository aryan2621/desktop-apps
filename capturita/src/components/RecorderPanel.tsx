import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppWindow, Camera, CameraOff, Check, Crop, EyeOff, Mic, MicOff, Monitor, RefreshCw, Search, Volume2, VolumeX, ZoomIn } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Display, type Permissions, type RecordingOptions, type Rect, type SourceList, type Thumbnails, type WindowSource } from '../lib/api';
import { Button, IconButton, Kbd, Popover, Segmented, Switch, cx } from './ui';

type Mode = 'display' | 'window' | 'area';

interface Settings {
    mode: Mode;
    displayId: number | null;
    windowId: number | null;
    area: { displayId: number; rect: Rect } | null;
    systemAudio: boolean;
    microphoneId: string;
    echoCancellation: boolean;
    cameraId: string;
}

const SETTINGS_KEY = 'capturita.recorder';
const defaults: Settings = { mode: 'display', displayId: null, windowId: null, area: null, systemAudio: true, microphoneId: '', echoCancellation: true, cameraId: '' };
/** Thumbnails are only fetched for this many windows, to keep the picker quick. */
const MAX_WINDOW_THUMBNAILS = 40;

function loadSettings(): Settings {
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    } catch {
        return defaults;
    }
}

export function RecorderPanel({ permissions, onPermissionsChange }: { permissions: Permissions | null; onPermissionsChange: (p: Permissions) => void }) {
    const [settings, setSettings] = useState<Settings>(loadSettings);
    const [sources, setSources] = useState<SourceList | null>(null);
    const [thumbnails, setThumbnails] = useState<Thumbnails>({ displays: {}, windows: {} });
    const [loadingSources, setLoadingSources] = useState(false);
    const [search, setSearch] = useState('');
    const [cameraVisible, setCameraVisible] = useState(false);
    const [busy, setBusy] = useState(false);
    const screenGranted = permissions?.screen === 'granted';

    const update = (change: Partial<Settings>) =>
        setSettings((current) => {
            const next = { ...current, ...change };
            try {
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
            } catch {
                // Settings just won't be remembered.
            }
            return next;
        });

    const refreshSources = useCallback(async () => {
        if (!screenGranted) return;
        setLoadingSources(true);
        try {
            const list = await api.listSources();
            setSources(list);
            // Previews load after the list so the picker appears straight away.
            api.thumbnails(
                list.displays.map((d) => d.id),
                list.windows.slice(0, MAX_WINDOW_THUMBNAILS).map((w) => w.id)
            )
                .then(setThumbnails)
                .catch(() => {});
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setLoadingSources(false);
        }
    }, [screenGranted]);

    useEffect(() => {
        refreshSources();
        // Windows open and close while Capturita is in the background.
        const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => focused && refreshSources());
        return () => {
            unlisten.then((fn) => fn());
        };
    }, [refreshSources]);

    const displays = sources?.displays ?? [];
    const mainDisplay = displays.find((d) => d.isMain) ?? displays[0];
    const displayId = displays.some((d) => d.id === settings.displayId) ? settings.displayId! : mainDisplay?.id;
    const selectedWindow = sources?.windows.find((w) => w.id === settings.windowId);
    const areaDisplay = displays.find((d) => d.id === (settings.area?.displayId ?? displayId));
    const query = search.trim().toLowerCase();
    const windows = (sources?.windows ?? []).filter((w) => !query || `${w.app} ${w.title}`.toLowerCase().includes(query));
    const microphones = sources?.microphones ?? [];
    const cameras = sources?.cameras ?? [];
    const microphone = microphones.find((m) => m.id === settings.microphoneId);
    const camera = cameras.find((c) => c.id === settings.cameraId);

    const ensurePermission = async (kind: 'microphone' | 'camera') => {
        if (permissions?.[kind] === 'granted') return true;
        const next = await api.requestPermission(kind);
        onPermissionsChange(next);
        if (next[kind] !== 'granted') {
            toast.error(`Allow ${kind} access for Capturita in System Settings → Privacy & Security.`);
            return false;
        }
        return true;
    };

    const selectMicrophone = async (id: string) => {
        if (id && !(await ensurePermission('microphone'))) return;
        update({ microphoneId: id });
    };

    const selectCamera = async (id: string) => {
        try {
            if (!id) {
                await api.hideCamera();
                setCameraVisible(false);
            } else {
                if (!(await ensurePermission('camera'))) return;
                await api.showCamera(id);
                setCameraVisible(true);
            }
            update({ cameraId: id });
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    const pickArea = async () => {
        const target = areaDisplay?.id ?? displayId;
        if (!target) return;
        try {
            const result = await api.pickArea(target);
            if (!result.cancelled && result.rect) {
                update({ mode: 'area', area: { displayId: target, rect: result.rect } });
            }
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    const buildOptions = (): RecordingOptions | string => {
        const common = {
            systemAudio: settings.systemAudio,
            microphoneId: settings.microphoneId || null,
            echoCancellation: settings.echoCancellation,
            fps: 60,
        };
        if (settings.mode === 'window') {
            if (!selectedWindow) return 'Choose a window to record';
            return { ...common, source: { type: 'window', windowId: selectedWindow.id } };
        }
        if (settings.mode === 'area') {
            if (!settings.area) return 'Select an area to record';
            return { ...common, source: { type: 'display', displayId: settings.area.displayId, rect: settings.area.rect } };
        }
        if (!displayId) return 'No display found';
        return { ...common, source: { type: 'display', displayId } };
    };

    const startRecording = async () => {
        const options = buildOptions();
        if (typeof options === 'string') {
            toast.error(options);
            return;
        }
        setBusy(true);
        try {
            await api.prepare(options);
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    // ⌘⇧R from anywhere: Rust forwards it here because this window owns the settings.
    const startRef = useRef(startRecording);
    startRef.current = startRecording;
    useEffect(() => {
        const unlisten = listen('shortcut-record', () => startRef.current());
        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    const ready = typeof buildOptions() !== 'string';
    const recordDisplay = displays.find((d) => d.id === displayId);
    const sourceLabel =
        settings.mode === 'window'
            ? selectedWindow?.app ?? 'a window'
            : settings.mode === 'area'
              ? `an area of ${areaDisplay?.name ?? 'the screen'}`
              : recordDisplay?.name ?? 'the screen';
    const notReady = !screenGranted ? 'Allow screen recording first' : ready ? null : (buildOptions() as string);

    return (
        <section className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-sm'>
            <div className='space-y-3 border-b border-line p-4'>
                <div className='flex items-center justify-between'>
                    <h2 className='font-serif text-lg font-medium tracking-tight'>New recording</h2>
                    <IconButton label='Refresh screens and windows' size='icon-sm' onClick={refreshSources} disabled={loadingSources || !screenGranted}>
                        <RefreshCw className={cx('h-3.5 w-3.5', loadingSources && 'animate-spin')} />
                    </IconButton>
                </div>
                <Segmented<Mode>
                    value={settings.mode}
                    onChange={(mode) => update({ mode })}
                    options={[
                        { value: 'display', label: 'Screen', icon: <Monitor className='h-4 w-4' />, hint: 'Record a whole display' },
                        { value: 'window', label: 'Window', icon: <AppWindow className='h-4 w-4' />, hint: 'Record one window' },
                        { value: 'area', label: 'Area', icon: <Crop className='h-4 w-4' />, hint: 'Record part of the screen' },
                    ]}
                />
                {settings.mode === 'window' && (
                    <label className='flex h-9 items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 focus-within:border-accent'>
                        <Search className='h-3.5 w-3.5 text-subtle' />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder='Search windows'
                            className='h-full flex-1 bg-transparent text-sm outline-none placeholder:text-subtle'
                            aria-label='Search windows'
                        />
                    </label>
                )}
            </div>

            <div className='flex min-h-0 flex-1 flex-col overflow-y-auto p-4'>
                {!screenGranted ? (
                    <p className='p-6 text-center text-sm text-muted'>Allow screen recording to see your screens and windows here.</p>
                ) : !sources ? (
                    <div className='grid gap-3'>
                        <Skeleton className='aspect-[16/10]' />
                        <Skeleton className='h-10' />
                    </div>
                ) : settings.mode === 'display' ? (
                    <div className='grid gap-3'>
                        {displays.map((display) => (
                            <DisplayCard
                                key={display.id}
                                display={display}
                                image={thumbnails.displays[display.id]}
                                selected={display.id === displayId}
                                onSelect={() => update({ displayId: display.id })}
                            />
                        ))}
                    </div>
                ) : settings.mode === 'window' ? (
                    windows.length === 0 ? (
                        <p className='p-6 text-center text-sm text-muted'>{query ? 'No windows match your search.' : 'No windows found.'}</p>
                    ) : (
                        <div className='grid grid-cols-2 gap-3'>
                            {windows.map((window) => (
                                <WindowCard
                                    key={window.id}
                                    window={window}
                                    image={thumbnails.windows[window.id]}
                                    selected={window.id === settings.windowId}
                                    onSelect={() => update({ windowId: window.id })}
                                />
                            ))}
                        </div>
                    )
                ) : (
                    <div className='space-y-3'>
                        {displays.length > 1 && (
                            <Segmented<number>
                                size='sm'
                                value={areaDisplay?.id ?? 0}
                                onChange={(id) => update({ displayId: id, area: settings.area?.displayId === id ? settings.area : null })}
                                options={displays.map((d) => ({ value: d.id, label: d.name, hint: `Pick an area on ${d.name}` }))}
                            />
                        )}
                        {areaDisplay && (
                            <button
                                onClick={pickArea}
                                className='group relative block w-full overflow-hidden rounded-xl border border-line bg-stage'
                                style={{ aspectRatio: `${areaDisplay.width} / ${areaDisplay.height}` }}
                                title='Drag out the area to record on this display'
                            >
                                {thumbnails.displays[areaDisplay.id] && (
                                    <img src={thumbnails.displays[areaDisplay.id]} className='absolute inset-0 h-full w-full object-cover opacity-70' draggable={false} />
                                )}
                                {settings.area?.displayId === areaDisplay.id ? (
                                    <span
                                        className='absolute rounded-sm border-2 border-accent bg-accent/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]'
                                        style={{
                                            left: `${(settings.area.rect.x / areaDisplay.width) * 100}%`,
                                            top: `${(settings.area.rect.y / areaDisplay.height) * 100}%`,
                                            width: `${(settings.area.rect.width / areaDisplay.width) * 100}%`,
                                            height: `${(settings.area.rect.height / areaDisplay.height) * 100}%`,
                                        }}
                                    />
                                ) : (
                                    <span className='absolute inset-0 flex items-center justify-center bg-black/35 text-sm font-medium text-white'>
                                        <Crop className='mr-2 h-4 w-4' /> Select an area
                                    </span>
                                )}
                            </button>
                        )}
                        {settings.area && (
                            <div className='flex items-center justify-between text-xs text-muted'>
                                <span className='font-mono'>
                                    {settings.area.rect.width} × {settings.area.rect.height} pt
                                </span>
                                <Button size='sm' variant='subtle' onClick={pickArea} title='Choose a different area'>
                                    <Crop className='h-3.5 w-3.5' /> Change
                                </Button>
                            </div>
                        )}
                    </div>
                )}
                {screenGranted && <Tip mode={settings.mode} />}
            </div>

            {/* Record bar */}
            <div className='space-y-3 border-t border-line bg-panel-2/60 p-4'>
                <div className='grid grid-cols-3 gap-2'>
                    <ToggleChip
                        active={settings.systemAudio}
                        onClick={() => update({ systemAudio: !settings.systemAudio })}
                        label='Mac audio'
                        status={settings.systemAudio ? 'On' : 'Off'}
                        icon={settings.systemAudio ? <Volume2 className='h-3.5 w-3.5' /> : <VolumeX className='h-3.5 w-3.5' />}
                    />
                    <Popover
                        side='top'
                        align='center'
                        trigger={(open, toggle) => (
                            <ToggleChip
                                active={!!microphone}
                                pressed={open}
                                onClick={toggle}
                                label='Microphone'
                                status={microphone ? microphone.name : 'Off'}
                                icon={microphone ? <Mic className='h-3.5 w-3.5' /> : <MicOff className='h-3.5 w-3.5' />}
                            />
                        )}
                    >
                        {(close) => (
                            <div className='w-64 space-y-1'>
                                <MenuHeading>Microphone</MenuHeading>
                                <MenuItem selected={!settings.microphoneId} onClick={() => (selectMicrophone(''), close())}>
                                    No microphone
                                </MenuItem>
                                {microphones.map((mic) => (
                                    <MenuItem key={mic.id} selected={mic.id === settings.microphoneId} onClick={() => (selectMicrophone(mic.id), close())}>
                                        {mic.name}
                                    </MenuItem>
                                ))}
                                {settings.microphoneId && (
                                    <div className='mt-2 space-y-1 border-t border-line px-2 pt-3'>
                                        <div className='flex items-center justify-between text-xs'>
                                            <span>Echo cancellation</span>
                                            <Switch label='Echo cancellation' checked={settings.echoCancellation} onChange={(echoCancellation) => update({ echoCancellation })} />
                                        </div>
                                        <p className='text-[11px] text-muted'>Keeps speaker sound out of your mic. Turn off with headphones for the most natural voice.</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </Popover>
                    <Popover
                        side='top'
                        align='end'
                        trigger={(open, toggle) => (
                            <ToggleChip
                                active={cameraVisible && !!camera}
                                pressed={open}
                                onClick={toggle}
                                label='Camera'
                                status={cameraVisible && camera ? camera.name : 'Off'}
                                icon={cameraVisible && camera ? <Camera className='h-3.5 w-3.5' /> : <CameraOff className='h-3.5 w-3.5' />}
                            />
                        )}
                    >
                        {(close) => (
                            <div className='w-64 space-y-1'>
                                <MenuHeading>Camera</MenuHeading>
                                <MenuItem selected={!cameraVisible} onClick={() => (selectCamera(''), close())}>
                                    No camera
                                </MenuItem>
                                {cameras.map((cam) => (
                                    <MenuItem key={cam.id} selected={cameraVisible && cam.id === settings.cameraId} onClick={() => (selectCamera(cam.id), close())}>
                                        {cam.name}
                                    </MenuItem>
                                ))}
                                {cameraVisible && <p className='px-2 pt-2 text-[11px] text-muted'>Drag the bubble anywhere. It's recorded separately, so you can move or hide it later.</p>}
                            </div>
                        )}
                    </Popover>
                </div>
                <p className='flex items-center gap-2 text-xs'>
                    <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', notReady ? 'bg-warning' : 'bg-success')} />
                    {notReady ? (
                        <span className='truncate text-warning-fg'>{notReady}</span>
                    ) : (
                        <span className='truncate text-muted'>
                            Ready to record <span className='font-medium text-fg'>{sourceLabel}</span>
                        </span>
                    )}
                </p>
                <Button
                    variant='record'
                    size='lg'
                    className='w-full'
                    onClick={startRecording}
                    disabled={!screenGranted || busy || !ready}
                    title={!screenGranted ? 'Allow screen recording first' : ready ? 'Start recording (⌘⇧R)' : (buildOptions() as string)}
                >
                    <span className='relative flex h-3 w-3'>
                        {!notReady && <span className='absolute inset-0 animate-ping rounded-full bg-white/60' />}
                        <span className='relative h-3 w-3 rounded-full bg-white' />
                    </span>
                    Start recording
                </Button>
                <p className='text-center text-xs text-subtle'>
                    or press <Kbd>⌘⇧R</Kbd> anywhere
                </p>
            </div>
        </section>
    );
}

function Skeleton({ className }: { className?: string }) {
    return <div className={cx('animate-pulse rounded-xl bg-panel-2', className)} />;
}

function DisplayCard({ display, image, selected, onSelect }: { display: Display; image?: string; selected: boolean; onSelect: () => void }) {
    return (
        <button
            onClick={onSelect}
            className={cx(
                'group overflow-hidden rounded-xl border text-left transition-colors',
                selected ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-strong'
            )}
            title={`Record ${display.name}`}
        >
            <div className='relative bg-stage' style={{ aspectRatio: `${display.width} / ${display.height}` }}>
                {image ? <img src={image} className='absolute inset-0 h-full w-full object-cover' draggable={false} /> : <div className='absolute inset-0 animate-pulse bg-panel-2' />}
                {selected && (
                    <span className='absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-fg shadow'>
                        <Check className='h-3.5 w-3.5' />
                    </span>
                )}
            </div>
            <div className='flex items-center justify-between gap-2 px-3 py-2'>
                <span className='truncate text-sm font-medium'>{display.name}</span>
                <span className='shrink-0 font-mono text-[11px] text-subtle'>
                    {display.width}×{display.height}
                    {display.isMain && ' · main'}
                </span>
            </div>
        </button>
    );
}

function WindowCard({ window, image, selected, onSelect }: { window: WindowSource; image?: string; selected: boolean; onSelect: () => void }) {
    return (
        <button
            onClick={onSelect}
            className={cx(
                'group flex flex-col overflow-hidden rounded-xl border text-left transition-colors',
                selected ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-strong'
            )}
            title={`Record ${window.app}${window.title ? ` — ${window.title}` : ''}`}
        >
            <div className='relative aspect-[16/10] bg-stage'>
                {image ? (
                    <img src={image} className='absolute inset-0 h-full w-full object-contain' draggable={false} />
                ) : (
                    window.icon && <img src={window.icon} className='absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 opacity-80' draggable={false} />
                )}
                {!window.isOnScreen && <span className='absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white'>Other Space</span>}
                {selected && (
                    <span className='absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-fg shadow'>
                        <Check className='h-3 w-3' />
                    </span>
                )}
            </div>
            <div className='flex min-w-0 items-center gap-2 px-2.5 py-2'>
                {window.icon && <img src={window.icon} className='h-4 w-4 shrink-0' draggable={false} />}
                <div className='min-w-0'>
                    <p className='truncate text-xs font-medium'>{window.app}</p>
                    <p className='truncate text-[11px] text-subtle'>{window.title || 'Untitled window'}</p>
                </div>
            </div>
        </button>
    );
}

/** An input to record (system audio, mic, camera): what it is, and what it's set to. */
function ToggleChip({ active, pressed, onClick, label, status, icon }: { active: boolean; pressed?: boolean; onClick: () => void; label: string; status: string; icon: ReactNode }) {
    return (
        <button
            onClick={onClick}
            title={`${label}: ${status}`}
            aria-label={`${label}: ${status}`}
            aria-pressed={active}
            className={cx(
                'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
                active ? 'border-accent/40 bg-accent/10' : 'border-line bg-panel hover:border-line-strong',
                pressed && 'ring-2 ring-accent/30'
            )}
        >
            <span className={cx('flex items-center gap-1.5 whitespace-nowrap text-xs font-medium', active ? 'text-accent' : 'text-muted')}>
                {icon}
                {label}
            </span>
            <span className='w-full truncate text-[11px] text-subtle'>{status}</span>
        </button>
    );
}

const TIPS = {
    display: { icon: ZoomIn, text: 'Auto-zoom follows your cursor, so details stay readable.' },
    window: { icon: Camera, text: 'The camera bubble is recorded separately: move or hide it later.' },
    area: { icon: EyeOff, text: 'Blur emails or keys later in the editor, no need to re-record.' },
};

/** A small tip at the bottom of the source list, for the mode picked. */
function Tip({ mode }: { mode: Mode }) {
    const tip = TIPS[mode];
    return (
        <div className='mt-auto pt-4'>
        <div className='flex items-center gap-2.5 rounded-xl bg-panel-2/70 px-3 py-2 text-xs text-muted'>
            <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent'>
                <tip.icon className='h-3.5 w-3.5' />
            </span>
            <span>
                <span className='font-medium text-fg'>Tip:</span> {tip.text}
            </span>
        </div>
        </div>
    );
}

function MenuHeading({ children }: { children: ReactNode }) {
    return <p className='px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle'>{children}</p>;
}

function MenuItem({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
    return (
        <button onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', selected ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg')}>
            <Check className={cx('h-3.5 w-3.5 shrink-0', selected ? 'text-accent' : 'invisible')} />
            <span className='truncate'>{children}</span>
        </button>
    );
}
