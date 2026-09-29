import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { ArrowLeft, Check, CircleAlert, Download, FastForward, FolderOpen, Gauge, Keyboard, Loader2, Minus, Pause, Play, Plus, Redo2, Rewind, Scissors, Trash2, Type, Undo2, X, ZoomIn } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, fileUrl, formatDuration, type CursorData, type Project } from '../lib/api';
import { Button, IconButton, Popover, RangeInput, cx } from '../components/ui';
import { CropOverlay } from '../editor/CropOverlay';
import { ExportDialog } from '../editor/ExportDialog';
import { ShortcutsSheet } from '../editor/ShortcutsSheet';
import { Inspector } from '../editor/Inspector';
import { TextHandle } from '../editor/TextHandle';
import { MAX_TIMELINE_ZOOM, MIN_TIMELINE_ZOOM, Timeline, type TimelineHandle } from '../editor/Timeline';
import { combinePeaks, computePeaks } from '../editor/waveform';
import { gainOf } from '../editor/audioSchedule';
import {
    aspectRatio,
    autoZooms,
    defaultEdit,
    MIN_ZOOM,
    newId,
    normalizeEdit,
    positionAt,
    removeClip,
    removeRange,
    TEXT_FADE,
    textAmount,
    timedSegments,
    totalDuration,
    type Clip,
    type Edit,
    type TextOverlay,
    type Zoom,
} from '../editor/model';
import { drawFrame, layoutFrame, videoFrame } from '../editor/render';
import { useHistory } from '../editor/useHistory';
import { usePlayback } from '../editor/usePlayback';
import { useThumbnails } from '../editor/useThumbnails';

const SAVE_DELAY_MS = 400;
const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3, 4];
/** Canvas resolution is capped so drawing stays fast on big screens. */
const MAX_PIXEL_RATIO = 2;

export function EditorView({ project, onClose }: { project: Project; onClose: () => void }) {
    const history = useHistory<Edit>(defaultEdit(project));
    const edit = history.value;
    const [loaded, setLoaded] = useState(false);
    const [cursor, setCursor] = useState<CursorData | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
    const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
    /** True when the recording had no edit.json yet, so auto-zoom runs once the cursor loads. */
    const freshRef = useRef(false);
    const [cropping, setCropping] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [showShortcuts, setShowShortcuts] = useState(false);
    const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
    const exportingRef = useRef(exporting);
    exportingRef.current = exporting;
    /** Output-time range marked for cutting (the two red markers), or null. */
    const [cutRange, setCutRange] = useState<[number, number] | null>(null);
    const [time, setTime] = useState(0);
    const [stage, setStage] = useState({ width: 0, height: 0 });

    const clickTimes = useMemo(() => cursor?.clicks.map(([t]) => t) ?? [], [cursor]);
    const playback = usePlayback(project, edit.clips, {
        enabled: edit.cursor.clickSound,
        type: edit.cursor.clickSoundType,
        volume: edit.cursor.clickVolume,
        times: clickTimes,
    }, edit.audio);
    const playbackRef = useRef(playback);
    playbackRef.current = playback;

    // Waveform: each track's peaks are computed once, then combined with the current volumes.
    const trackPeaks = useMemo(
        () =>
            (playback.audio ?? []).map(({ kind, track, buffer }) => ({
                kind,
                peaks: computePeaks(
                    [
                        {
                            channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
                            sampleRate: buffer.sampleRate,
                            offset: track.offset,
                            gain: 1,
                        },
                    ],
                    project.duration
                ),
            })),
        [playback.audio, project.duration]
    );
    const waveform = useMemo(
        () => combinePeaks(trackPeaks.map(({ kind, peaks }) => ({ peaks, gain: gainOf(edit.audio[kind]) }))),
        [trackPeaks, edit.audio]
    );
    const [timelineZoom, setTimelineZoom] = useState(1);
    const clampZoom = (value: number) => Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, value));
    const thumbnails = useThumbnails(project);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const timelineRef = useRef<TimelineHandle>(null);
    const editRef = useRef(edit);
    editRef.current = edit;
    const croppingRef = useRef(cropping);
    croppingRef.current = cropping;

    // Load edit.json and the cursor track.
    useEffect(() => {
        let cancelled = false;
        api.loadEdit(project.id)
            .then((saved) => {
                if (cancelled) return;
                freshRef.current = saved == null;
                history.reset(normalizeEdit(project, saved));
            })
            .catch((error) => toast.error(`Could not load your edits: ${errorMessage(error)}`))
            .finally(() => !cancelled && setLoaded(true));
        fetch(fileUrl(project, project.tracks.cursor.file))
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => !cancelled && setCursor(data))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project]);

    // A new recording starts with zooms around its clicks, like Screen Studio.
    useEffect(() => {
        if (!loaded || !cursor || !freshRef.current) return;
        freshRef.current = false;
        if (cursor.clicks.length === 0 || editRef.current.zooms.length > 0) return;
        history.reset({ ...editRef.current, zooms: autoZooms(cursor, project.duration, editRef.current.zoomScale) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, cursor]);

    // Auto-save shortly after each change, and once more when leaving the editor.
    const pendingSave = useRef<Edit | null>(null);
    const flushSave = useCallback(() => {
        const value = pendingSave.current;
        if (!value) return Promise.resolve();
        pendingSave.current = null;
        setSaveState('saving');
        return api
            .saveEdit(project.id, value)
            .then(() => setSaveState(pendingSave.current ? 'pending' : 'saved'))
            .catch((error) => {
                setSaveState('error');
                toast.error(`Could not save your edits: ${errorMessage(error)}`);
            });
    }, [project.id]);
    const skipSave = useRef(true);
    useEffect(() => {
        if (!loaded) return;
        if (skipSave.current) {
            skipSave.current = false;
            return;
        }
        pendingSave.current = edit;
        setSaveState('pending');
        const timeout = setTimeout(flushSave, SAVE_DELAY_MS);
        return () => clearTimeout(timeout);
    }, [edit, loaded, flushSave]);
    useEffect(() => () => void flushSave(), [flushSave]);

    // Fit the output frame into the available stage.
    useEffect(() => {
        const element = stageRef.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setStage({ width: entry.contentRect.width, height: entry.contentRect.height }));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const aspect = aspectRatio(edit, project);
    const frameWidth = Math.max(1, Math.min(stage.width, stage.height * aspect));
    const frameHeight = frameWidth / aspect;

    // One loop draws every frame and moves the playhead; React state updates are throttled.
    const lastTimeUpdate = useRef(0);
    useEffect(() => {
        let frame = 0;
        const loop = () => {
            const playback = playbackRef.current;
            const t = playback.tick();
            timelineRef.current?.setPlayhead(t);
            const now = performance.now();
            if (now - lastTimeUpdate.current > 100) {
                lastTimeUpdate.current = now;
                setTime(t);
            }
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            if (canvas && ctx) {
                const current = editRef.current;
                const position = positionAt(current.clips, t);
                const camera = project.tracks.camera;
                const cameraLocal = camera ? position.source - camera.offset : -1;
                drawFrame(ctx, canvas.width, canvas.height, {
                    edit: current,
                    project,
                    screen: videoFrame(playback.screenRef.current),
                    camera: videoFrame(playback.cameraRef.current),
                    cameraActive: !!camera && cameraLocal >= 0 && cameraLocal < camera.duration,
                    cursor,
                    time: position.source,
                    ignoreCrop: croppingRef.current,
                });
            }
            frame = requestAnimationFrame(loop);
        };
        frame = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(frame);
    }, [project, cursor]);

    const setClips = useCallback((clips: Clip[], key?: string) => history.set((e) => ({ ...e, clips }), key), [history]);
    const change = useCallback((partial: Partial<Edit>, key: string) => history.set((e) => ({ ...e, ...partial }), key), [history]);

    const togglePlay = () => (playback.playing ? playback.pause() : playback.play(playback.now()));

    /** First press shows two markers around the playhead; the second cuts out what's between them. */
    const cut = () => {
        const total = totalDuration(edit.clips);
        if (!cutRange) {
            const width = Math.min(5, total * 0.2);
            const center = Math.min(Math.max(playback.now(), width / 2), total - width / 2);
            setCutRange([Math.max(0, center - width / 2), Math.min(total, center + width / 2)]);
            return;
        }
        if (Math.abs(cutRange[1] - cutRange[0]) < 0.1) {
            toast.info('Drag the red markers apart to choose what to cut.');
            return;
        }
        const clips = removeRange(edit.clips, cutRange[0], cutRange[1]);
        if (!clips) {
            toast.info('That would cut the whole video. Move a marker to keep some of it.');
            return;
        }
        setClips(clips);
        setCutRange(null);
        setSelectedId(null);
        playback.seek(Math.min(...cutRange));
    };
    const cancelCut = () => setCutRange(null);

    const selected = edit.clips.find((clip) => clip.id === selectedId) ?? null;
    const selectedZoom = edit.zooms.find((zoom) => zoom.id === selectedZoomId) ?? null;
    const setZooms = useCallback((zooms: Zoom[], key?: string) => history.set((e) => ({ ...e, zooms }), key), [history]);
    const selectedText = edit.texts.find((text) => text.id === selectedTextId) ?? null;
    const setTexts = useCallback((texts: TextOverlay[], key?: string) => history.set((e) => ({ ...e, texts }), key), [history]);
    /** Only one thing (clip, zoom or text) is selected at a time. */
    const select = (kind: 'clip' | 'zoom' | 'text', id: string | null) => {
        setSelectedId(kind === 'clip' ? id : null);
        setSelectedZoomId(kind === 'zoom' ? id : null);
        setSelectedTextId(kind === 'text' ? id : null);
    };
    const selectClip = (id: string | null) => select('clip', id);
    const selectZoom = (id: string | null) => select('zoom', id);
    /** Selecting a text also moves the playhead into it, so it's visible and can be dragged. */
    const selectText = (id: string | null) => {
        select('text', id);
        const text = edit.texts.find((t) => t.id === id);
        if (!text) return;
        const current = positionAt(edit.clips, playback.now()).source;
        if (textAmount(text, current) > 0) return;
        const segment = timedSegments(edit.clips, [text])[0];
        if (segment) playback.seek(Math.min(segment.to, segment.from + TEXT_FADE));
    };
    /** Adds a 3-second text starting at the playhead (inside the current clip). */
    const addText = () => {
        const { clip, source } = positionAt(edit.clips, playback.now());
        let start = source;
        let end = Math.min(clip.end, start + 3);
        if (end - start < MIN_ZOOM) start = Math.max(clip.start, end - 3);
        if (end - start < MIN_ZOOM) {
            toast.info('This clip is too short for text.');
            return;
        }
        const text: TextOverlay = { id: newId(), start, end, text: 'Your text', x: 0.5, y: 0.18, size: 0.07, color: '#ffffff', bold: true, background: 'none', font: 'system' };
        setTexts([...edit.texts, text].sort((a, b) => a.start - b.start));
        select('text', text.id);
        playback.seek(Math.min(playback.total, playback.now() + TEXT_FADE));
    };
    const deleteText = (id: string) => {
        setTexts(edit.texts.filter((text) => text.id !== id));
        setSelectedTextId(null);
    };
    const deleteZoom = (id: string) => {
        setZooms(edit.zooms.filter((zoom) => zoom.id !== id));
        setSelectedZoomId(null);
    };
    /** Adds a 3-second zoom starting at the playhead (inside the current clip). */
    const addZoom = () => {
        const { clip, source } = positionAt(edit.clips, playback.now());
        let start = source;
        let end = Math.min(clip.end, start + 3);
        if (end - start < MIN_ZOOM) start = Math.max(clip.start, end - 3);
        if (end - start < MIN_ZOOM) {
            toast.info('This clip is too short to zoom.');
            return;
        }
        const zoom: Zoom = { id: newId(), start, end, scale: edit.zoomScale, mode: 'follow', x: 0.5, y: 0.5, auto: false };
        setZooms([...edit.zooms, zoom].sort((a, b) => a.start - b.start));
        selectZoom(zoom.id);
    };
    const runAutoZoom = () => {
        if (!cursor) return;
        // Keep zooms the user made or changed; replace the automatic ones.
        const manual = edit.zooms.filter((zoom) => !zoom.auto);
        setZooms([...manual, ...autoZooms(cursor, project.duration, edit.zoomScale)].sort((a, b) => a.start - b.start));
        setSelectedZoomId(null);
        toast.success('Zooms re-created from your clicks');
    };
    const deleteSelected = () => {
        if (selectedText) {
            deleteText(selectedText.id);
            return;
        }
        if (selectedZoom) {
            deleteZoom(selectedZoom.id);
            return;
        }
        if (!selected || edit.clips.length <= 1) return;
        setClips(removeClip(edit.clips, selected.id));
        setSelectedId(null);
    };
    /** Speed applies to the selected clip, or to the clip under the playhead when none is selected. */
    const speedTarget = selected ?? positionAt(edit.clips, time).clip;
    const setSpeed = (speed: number) => {
        setClips(
            edit.clips.map((clip) => (clip.id === speedTarget.id ? { ...clip, speed } : clip)),
            `speed-${speedTarget.id}`
        );
    };
    const applyZoomScaleToAll = () => setZooms(edit.zooms.map((zoom) => ({ ...zoom, scale: edit.zoomScale, auto: false })));

    // Keyboard shortcuts (ignored while typing in a field).
    const openExport = () => {
        playback.pause();
        setExporting(true);
    };

    const skip = (seconds: number) => playback.seek(Math.min(playback.total, Math.max(0, playback.now() + seconds)));

    const actions = {
        togglePlay,
        cut,
        cancelCut,
        deleteSelected,
        addText,
        openExport,
        skip,
        shortcuts: () => setShowShortcuts(true),
        zoomTimeline: (factor: number | null) => setTimelineZoom((z) => (factor === null ? 1 : clampZoom(z * factor))),
        undo: history.undo,
        redo: history.redo,
    };
    const keyActions = useRef(actions);
    keyActions.current = actions;
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement;
            const inField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
            if (inField && (target as HTMLInputElement).type !== 'range') return;
            // The export dialog owns the keyboard while it's open.
            if (exportingRef.current) return;
            const actions = keyActions.current;
            if (event.metaKey && (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0')) {
                event.preventDefault();
                actions.zoomTimeline(event.key === '0' ? null : event.key === '-' ? 1 / 1.5 : 1.5);
            } else if (event.metaKey && event.key.toLowerCase() === 'e') {
                event.preventDefault();
                actions.openExport();
            } else if (event.metaKey && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                if (event.shiftKey) actions.redo();
                else actions.undo();
            } else if (event.code === 'Space') {
                event.preventDefault();
                actions.togglePlay();
            } else if (!event.metaKey && event.key.toLowerCase() === 's') {
                actions.cut();
            } else if (!event.metaKey && event.key.toLowerCase() === 't') {
                actions.addText();
            } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !inField && !event.metaKey) {
                // Sliders keep their own arrow keys.
                event.preventDefault();
                actions.skip(event.key === 'ArrowLeft' ? -5 : 5);
            } else if (event.key === '?') {
                actions.shortcuts();
            } else if (event.key === 'Escape') {
                actions.cancelCut();
            } else if (event.key === 'Backspace' || event.key === 'Delete') {
                actions.deleteSelected();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const close = async () => {
        playback.pause();
        await flushSave();
        onClose();
    };

    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const cropFrame = cropping ? layoutFrame(edit, project, frameWidth, frameHeight, true) : null;

    return (
        <div className='flex h-full flex-col'>
            <header className='flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-3'>
                <IconButton label='Back to recordings' onClick={close}>
                    <ArrowLeft className='h-4 w-4' />
                </IconButton>
                <div className='min-w-0'>
                    <p className='truncate text-sm font-semibold'>{project.source.name}</p>
                    <p className='text-xs text-muted'>{new Date(project.createdAt).toLocaleString()}</p>
                </div>
                <SaveStatus state={saveState} />
                <div className='ml-auto flex items-center gap-1'>
                    <IconButton label='Undo (⌘Z)' onClick={history.undo} disabled={!history.canUndo}>
                        <Undo2 className='h-4 w-4' />
                    </IconButton>
                    <IconButton label='Redo (⌘⇧Z)' onClick={history.redo} disabled={!history.canRedo}>
                        <Redo2 className='h-4 w-4' />
                    </IconButton>
                    <span className='mx-1 h-5 w-px bg-line' aria-hidden />
                    <IconButton label='Show in Finder' onClick={() => revealItemInDir(project.path)}>
                        <FolderOpen className='h-4 w-4' />
                    </IconButton>
                    <IconButton label='Keyboard shortcuts (?)' onClick={() => setShowShortcuts(true)}>
                        <Keyboard className='h-4 w-4' />
                    </IconButton>
                    <Button variant='primary' className='ml-2' onClick={openExport} disabled={!loaded} title='Export or upload (⌘E)'>
                        <Download className='h-4 w-4' /> Export
                    </Button>
                </div>
            </header>

            <div className='flex min-h-0 flex-1'>
                <div className='flex min-w-0 flex-1 flex-col'>
                    <div ref={stageRef} className='relative flex min-h-0 flex-1 items-center justify-center bg-stage p-6'>
                        <div className='relative' style={{ width: frameWidth, height: frameHeight }}>
                            <canvas
                                ref={canvasRef}
                                width={Math.round(frameWidth * pixelRatio)}
                                height={Math.round(frameHeight * pixelRatio)}
                                className='h-full w-full rounded-lg shadow-2xl'
                                onClick={() => !cropping && playback.ready && togglePlay()}
                            />
                            {cropFrame && <CropOverlay frame={cropFrame} crop={edit.crop} onChange={(crop) => change({ crop }, 'crop')} />}
                            {!cropping && selectedText && textAmount(selectedText, positionAt(edit.clips, time).source) > 0 && (
                                <TextHandle
                                    text={selectedText}
                                    width={frameWidth}
                                    height={frameHeight}
                                    onMove={(x, y) => setTexts(edit.texts.map((t) => (t.id === selectedText.id ? { ...t, x, y } : t)), `text-move-${selectedText.id}`)}
                                />
                            )}
                        </div>
                        {!playback.ready && (
                            <div className='absolute inset-0 flex items-center justify-center'>
                                <Loader2 className='h-6 w-6 animate-spin text-muted' />
                            </div>
                        )}
                    </div>

                    <div className='shrink-0 space-y-2 border-t border-line bg-panel px-4 pb-4 pt-2'>
                        <div className='grid grid-cols-[1fr_auto_1fr] items-center gap-4'>
                            <div className='flex items-center gap-1'>
                                <IconButton
                                    label={cutRange ? 'Cut out the marked part (S)' : 'Mark a part to cut (S)'}
                                    variant={cutRange ? 'danger' : 'ghost'}
                                    onClick={cut}
                                >
                                    <Scissors className='h-4 w-4' />
                                </IconButton>
                                {cutRange && (
                                    <IconButton label='Cancel cutting (Esc)' onClick={cancelCut}>
                                        <X className='h-4 w-4' />
                                    </IconButton>
                                )}
                                <IconButton label='Add a zoom at the playhead' onClick={addZoom}>
                                    <ZoomIn className='h-4 w-4' />
                                </IconButton>
                                <IconButton label='Add text at the playhead (T)' onClick={addText}>
                                    <Type className='h-4 w-4' />
                                </IconButton>
                                <span className='mx-1 h-5 w-px bg-line' aria-hidden />
                                <IconButton
                                    label={selectedText ? 'Delete selected text (⌫)' : selectedZoom ? 'Delete selected zoom (⌫)' : 'Delete selected clip (⌫)'}
                                    onClick={deleteSelected}
                                    disabled={!selectedText && !selectedZoom && (!selected || edit.clips.length <= 1)}
                                >
                                    <Trash2 className='h-4 w-4' />
                                </IconButton>
                            </div>

                            <div className='flex items-center gap-2'>
                                <IconButton label='Back 5 seconds (←)' onClick={() => skip(-5)} disabled={!playback.ready}>
                                    <Rewind className='h-4 w-4' />
                                </IconButton>
                                <Button
                                    variant='primary'
                                    className='h-10 w-10 rounded-full p-0'
                                    onClick={togglePlay}
                                    disabled={!playback.ready}
                                    title={playback.playing ? 'Pause (Space)' : 'Play (Space)'}
                                    aria-label={playback.playing ? 'Pause' : 'Play'}
                                >
                                    {playback.playing ? <Pause className='h-4 w-4 fill-current' /> : <Play className='ml-0.5 h-4 w-4 fill-current' />}
                                </Button>
                                <IconButton label='Forward 5 seconds (→)' onClick={() => skip(5)} disabled={!playback.ready}>
                                    <FastForward className='h-4 w-4' />
                                </IconButton>
                                <span className='ml-1 font-mono text-xs tabular-nums'>
                                    <span className='text-fg'>{formatDuration(time)}</span>
                                    <span className='text-subtle'> / {formatDuration(playback.total)}</span>
                                </span>
                            </div>

                            <div className='flex items-center justify-end gap-1'>
                                <div className='mr-2 flex items-center gap-1' title={`Timeline zoom ${timelineZoom.toFixed(1)}× (⌘− / ⌘+ / ⌘0, or pinch)`}>
                                    <IconButton label='Zoom the timeline out (⌘−)' size='icon-sm' onClick={() => setTimelineZoom((z) => clampZoom(z / 1.5))} disabled={timelineZoom <= MIN_TIMELINE_ZOOM}>
                                        <Minus className='h-3.5 w-3.5' />
                                    </IconButton>
                                    <RangeInput
                                        className='w-20'
                                        min={0}
                                        max={100}
                                        step={1}
                                        value={(Math.log(timelineZoom) / Math.log(MAX_TIMELINE_ZOOM)) * 100}
                                        onChange={(e) => setTimelineZoom(clampZoom(Math.exp((Number(e.target.value) / 100) * Math.log(MAX_TIMELINE_ZOOM))))}
                                        aria-label='Timeline zoom'
                                    />
                                    <IconButton label='Zoom the timeline in (⌘+)' size='icon-sm' onClick={() => setTimelineZoom((z) => clampZoom(z * 1.5))} disabled={timelineZoom >= MAX_TIMELINE_ZOOM}>
                                        <Plus className='h-3.5 w-3.5' />
                                    </IconButton>
                                </div>
                                <Popover
                                    align='end'
                                    side='top'
                                    trigger={(open, toggle) => (
                                        <Button
                                            variant={open ? 'subtle' : 'ghost'}
                                            size='sm'
                                            onClick={toggle}
                                            title={
                                                edit.clips.length === 1
                                                    ? 'Speed of the whole video'
                                                    : selected
                                                      ? 'Speed of the selected clip'
                                                      : 'Speed of the clip under the playhead (select a clip to pick another)'
                                            }
                                            aria-label='Clip speed'
                                        >
                                            <Gauge className='h-4 w-4' />
                                            <span className='font-mono'>{speedTarget.speed}×</span>
                                        </Button>
                                    )}
                                >
                                    <div className='w-60 space-y-3 p-1'>
                                        <div className='flex justify-between text-xs'>
                                            <span>{edit.clips.length === 1 ? 'Video speed' : selected ? 'Selected clip speed' : 'Speed of the clip at the playhead'}</span>
                                            <span className='font-mono text-muted'>{speedTarget.speed}×</span>
                                        </div>
                                        <RangeInput min={0.5} max={4} step={0.25} value={speedTarget.speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label='Clip speed' />
                                        <div className='grid grid-cols-6 gap-1'>
                                            {SPEED_PRESETS.map((speed) => (
                                                <button
                                                    key={speed}
                                                    onClick={() => setSpeed(speed)}
                                                    className={cx(
                                                        'h-7 rounded-md font-mono text-xs',
                                                        speedTarget.speed === speed ? 'bg-accent text-accent-fg' : 'bg-panel-2 text-muted hover:text-fg'
                                                    )}
                                                    title={`${speed}× speed`}
                                                >
                                                    {speed}×
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </Popover>
                            </div>
                        </div>
                        <Timeline
                            ref={timelineRef}
                            clips={edit.clips}
                            sourceDuration={project.duration}
                            thumbnails={thumbnails}
                            waveform={waveform}
                            zoom={timelineZoom}
                            onZoomChange={setTimelineZoom}
                            selectedId={selectedId}
                            onSelect={selectClip}
                            onSeek={playback.seek}
                            onClipsChange={setClips}
                            range={cutRange}
                            onRangeChange={setCutRange}
                            zooms={edit.zooms}
                            selectedZoomId={selectedZoomId}
                            onSelectZoom={selectZoom}
                            onZoomsChange={setZooms}
                            texts={edit.texts}
                            selectedTextId={selectedTextId}
                            onSelectText={selectText}
                            onTextsChange={setTexts}
                        />
                    </div>
                </div>

                <aside className='w-[352px] shrink-0 border-l border-line bg-panel'>
                    <Inspector
                        edit={edit}
                        hasCamera={!!project.tracks.camera}
                        cropping={cropping}
                        onChange={change}
                        onCropToggle={() => setCropping((c) => !c)}
                        selectedZoom={selectedZoom}
                        hasClicks={(cursor?.clicks.length ?? 0) > 0}
                        onZoomChange={(zoom, key) => setZooms(edit.zooms.map((z) => (z.id === zoom.id ? zoom : z)), key)}
                        onZoomDelete={deleteZoom}
                        onAutoZoom={runAutoZoom}
                        onApplyZoomScaleToAll={applyZoomScaleToAll}
                        selectedText={selectedText}
                        onAddText={addText}
                        onTextChange={(text, key) => setTexts(edit.texts.map((t) => (t.id === text.id ? text : t)), key)}
                        onTextDelete={deleteText}
                        hasSystemAudio={!!project.tracks.systemAudio}
                        hasMicrophone={!!project.tracks.microphone}
                    />
                </aside>
            </div>

            {showShortcuts && <ShortcutsSheet onClose={() => setShowShortcuts(false)} />}
            {exporting && <ExportDialog project={project} edit={edit} cursor={cursor} onClose={() => setExporting(false)} />}

            {/* Frame sources for the canvas. Kept in the page (not display:none) so WebKit keeps decoding them. */}
            <div className='pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0' aria-hidden>
                <video ref={playback.screenRef} src={fileUrl(project, project.tracks.screen.file)} muted playsInline preload='auto' />
                {project.tracks.camera && <video ref={playback.cameraRef} src={fileUrl(project, project.tracks.camera.file)} muted playsInline preload='auto' />}
            </div>
        </div>
    );
}

/** Auto-save state next to the project name. */
function SaveStatus({ state }: { state: 'saved' | 'pending' | 'saving' | 'error' }) {
    if (state === 'error') {
        return (
            <span className='flex items-center gap-1 text-xs text-danger-fg' title='Your last change could not be saved; it will be retried with the next change'>
                <CircleAlert className='h-3.5 w-3.5' /> Not saved
            </span>
        );
    }
    const saving = state === 'saving' || state === 'pending';
    return (
        <span className='flex items-center gap-1 text-xs text-subtle' title={saving ? 'Saving your changes' : 'All changes are saved'}>
            {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <Check className='h-3.5 w-3.5' />}
            {saving ? 'Saving…' : 'Saved'}
        </span>
    );
}
