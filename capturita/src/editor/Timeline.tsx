import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AudioLines, Film, Type, ZoomIn } from 'lucide-react';
import { formatDuration } from '../lib/api';
import { cx } from '../components/ui';
import { clipLength, clipStarts, edgeLimits, MIN_ZOOM, snapTo, timedSegments, totalDuration, type Clip, type TextOverlay, type TimedItem, type Zoom } from './model';
import type { Thumbnail } from './useThumbnails';
import { peakBetween } from './waveform';

export interface TimelineHandle {
    /** Moves the playhead without re-rendering React (called every frame while playing). */
    setPlayhead: (outputTime: number) => void;
}

export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 20;

interface TimelineProps {
    clips: Clip[];
    sourceDuration: number;
    thumbnails: Thumbnail[];
    /** Audio peaks over source time (see waveform.ts), or null while loading. */
    waveform: Float32Array | null;
    /** Horizontal zoom: 1 fits the whole video, up to MAX_TIMELINE_ZOOM. */
    zoom: number;
    onZoomChange: (zoom: number) => void;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onSeek: (outputTime: number) => void;
    onClipsChange: (clips: Clip[], key: string) => void;
    /** Output-time range marked for cutting, shown as two draggable markers. */
    range: [number, number] | null;
    onRangeChange: (range: [number, number]) => void;
    zooms: Zoom[];
    selectedZoomId: string | null;
    onSelectZoom: (id: string | null) => void;
    onZoomsChange: (zooms: Zoom[], key: string) => void;
    texts: TextOverlay[];
    selectedTextId: string | null;
    onSelectText: (id: string | null) => void;
    onTextsChange: (texts: TextOverlay[], key: string) => void;
}

/** A row of timed items (zooms, texts) under the clips. */
interface RowSpec<T extends TimedItem> {
    top: number;
    items: T[];
    selectedItemId: string | null;
    onSelectItem: (id: string | null) => void;
    onItemsChange: (items: T[], key: string) => void;
    kind: string;
    label: (item: T) => string;
    title: (item: T) => string;
    /** Extra fields to set when an item is resized (zooms stop being "auto"). */
    patch?: Partial<T>;
    className: { idle: string; selected: string };
}

const RULER_HEIGHT = 24;
const CLIP_HEIGHT = 56;
const ROW_HEIGHT = 22;
const AUDIO_HEIGHT = 34;
const GAP = 6;
const ZOOM_TOP = CLIP_HEIGHT + GAP;
const TEXT_TOP = ZOOM_TOP + ROW_HEIGHT + GAP;
const AUDIO_TOP = TEXT_TOP + ROW_HEIGHT + GAP;
const LANES_HEIGHT = AUDIO_TOP + AUDIO_HEIGHT;
const HANDLE_WIDTH = 10;
/** Edges snap to targets within this many pixels; hold Option to drag freely. */
const SNAP_PIXELS = 6;

const LANES: { top: number; height: number; label: string; icon: ReactNode }[] = [
    { top: 0, height: CLIP_HEIGHT, label: 'Clips — drag an edge to trim', icon: <Film className='h-3.5 w-3.5' /> },
    { top: ZOOM_TOP, height: ROW_HEIGHT, label: 'Zooms', icon: <ZoomIn className='h-3.5 w-3.5' /> },
    { top: TEXT_TOP, height: ROW_HEIGHT, label: 'Text', icon: <Type className='h-3.5 w-3.5' /> },
    { top: AUDIO_TOP, height: AUDIO_HEIGHT, label: 'Audio', icon: <AudioLines className='h-3.5 w-3.5' /> },
];

export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(props, ref) {
    const {
        clips,
        sourceDuration,
        thumbnails,
        waveform,
        zoom,
        onZoomChange,
        selectedId,
        onSelect,
        onSeek,
        onClipsChange,
        range,
        onRangeChange,
        zooms,
        selectedZoomId,
        onSelectZoom,
        onZoomsChange,
        texts,
        selectedTextId,
        onSelectText,
        onTextsChange,
    } = props;
    const viewportRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const playheadRef = useRef<HTMLDivElement>(null);
    const [viewWidth, setViewWidth] = useState(0);
    const lastPlayhead = useRef(0);
    const dragging = useRef(false);
    // While an edge is dragged the scale is frozen, so the clip doesn't jump under the pointer.
    const [frozenScale, setFrozenScale] = useState<number | null>(null);
    const [snapLine, setSnapLine] = useState<number | null>(null);

    const total = totalDuration(clips);
    const contentWidth = Math.max(viewWidth, viewWidth * zoom);
    const scale = frozenScale ?? (total > 0 ? contentWidth / total : 0); // pixels per output second
    const starts = clipStarts(clips);

    useEffect(() => {
        const element = viewportRef.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setViewWidth(entry.contentRect.width));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // Keep the time under the pointer (or the playhead) in place when the zoom changes.
    const anchor = useRef<{ time: number; x: number } | null>(null);
    const previousScale = useRef(scale);
    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || previousScale.current === scale) return;
        const target = anchor.current ?? { time: lastPlayhead.current, x: lastPlayhead.current * previousScale.current - viewport.scrollLeft };
        viewport.scrollLeft = Math.max(0, target.time * scale - target.x);
        anchor.current = null;
        previousScale.current = scale;
    }, [scale]);

    // Pinch (or ⌘/Ctrl + scroll) zooms around the pointer.
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const scaleRef = useRef(scale);
    scaleRef.current = scale;
    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            const x = event.clientX - viewport.getBoundingClientRect().left;
            anchor.current = { time: (viewport.scrollLeft + x) / scaleRef.current, x };
            const next = zoomRef.current * Math.exp(-event.deltaY * 0.01);
            onZoomChange(Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, next)));
        };
        viewport.addEventListener('wheel', onWheel, { passive: false });
        return () => viewport.removeEventListener('wheel', onWheel);
    }, [onZoomChange]);

    const placePlayhead = (t: number) => {
        lastPlayhead.current = t;
        const x = t * scale;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
        // Keep the playhead in view while playing or stepping, but not while the user scrubs.
        const viewport = viewportRef.current;
        if (viewport && !dragging.current && zoom > 1) {
            if (x > viewport.scrollLeft + viewport.clientWidth - 24 || x < viewport.scrollLeft) {
                viewport.scrollLeft = Math.max(0, x - viewport.clientWidth * 0.2);
            }
        }
    };
    useImperativeHandle(ref, () => ({ setPlayhead: placePlayhead }));
    useEffect(() => placePlayhead(lastPlayhead.current));

    const timeAt = (clientX: number) => {
        const rect = containerRef.current!.getBoundingClientRect();
        return Math.min(total, Math.max(0, (clientX - rect.left) / scale));
    };

    /** Output times that edges snap to: the playhead, clip boundaries, zoom/text edges and cut markers. */
    const snapTargets = (exclude?: string) => {
        const targets = [0, total, lastPlayhead.current, ...starts, ...clips.map((clip, i) => starts[i] + clipLength(clip))];
        for (const segment of timedSegments(clips, [...zooms, ...texts])) {
            if (segment.item.id !== exclude) targets.push(segment.from, segment.to);
        }
        if (range) targets.push(...range);
        return targets;
    };
    const snap = (outputTime: number, event: PointerEvent, exclude?: string) => {
        if (event.altKey) {
            setSnapLine(null);
            return outputTime;
        }
        const result = snapTo(outputTime, snapTargets(exclude), SNAP_PIXELS / scale);
        setSnapLine(result.snapped);
        return result.value;
    };

    /** Shared pointer-drag plumbing: capture the pointer, call `move`, clean up on release. */
    const drag = (event: ReactPointerEvent, move: (e: PointerEvent) => void, done?: () => void) => {
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        dragging.current = true;
        const up = () => {
            dragging.current = false;
            setSnapLine(null);
            done?.();
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    };

    /** Click or drag on the track or ruler to scrub. */
    const startScrub = (event: ReactPointerEvent) => {
        if (event.button !== 0) return;
        onSeek(timeAt(event.clientX));
        drag(event, (e) => onSeek(timeAt(e.clientX)));
    };

    const startTrim = (event: ReactPointerEvent, index: number, edge: 'start' | 'end') => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const clip = clips[index];
        const originX = event.clientX;
        const original = clip[edge];
        const limits = edgeLimits(clips, index, edge, sourceDuration);
        const dragScale = scale;
        setFrozenScale(dragScale);
        onSelect(clip.id);
        drag(
            event,
            (e) => {
                let value = original + ((e.clientX - originX) / dragScale) * clip.speed;
                // The end edge moves on the timeline, so it can snap; trimming the start slides the content instead.
                if (edge === 'end') value = clip.start + (snap(starts[index] + (value - clip.start) / clip.speed, e) - starts[index]) * clip.speed;
                value = Math.min(limits.max, Math.max(limits.min, value));
                onClipsChange(
                    clips.map((c, i) => (i === index ? { ...c, [edge]: value } : c)),
                    `trim-${clip.id}-${edge}`
                );
            },
            () => setFrozenScale(null)
        );
    };

    /** Drags the start or end of a timed item (edges show on the pieces where it begins or ends). */
    const startItemEdge = <T extends TimedItem>(event: ReactPointerEvent, row: RowSpec<T>, item: T, clipIndex: number, edge: 'start' | 'end') => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const clip = clips[clipIndex];
        const originX = event.clientX;
        const original = item[edge];
        const dragScale = scale;
        row.onSelectItem(item.id);
        drag(event, (e) => {
            const raw = original + ((e.clientX - originX) / dragScale) * clip.speed;
            const snapped = clip.start + (snap(starts[clipIndex] + (raw - clip.start) / clip.speed, e, item.id) - starts[clipIndex]) * clip.speed;
            const value =
                edge === 'start'
                    ? Math.min(item.end - MIN_ZOOM, Math.max(0, snapped))
                    : Math.max(item.start + MIN_ZOOM, Math.min(sourceDuration, snapped));
            row.onItemsChange(
                row.items.map((i) => (i.id === item.id ? { ...i, ...row.patch, [edge]: value } : i)),
                `${row.kind}-${item.id}-${edge}`
            );
        });
    };

    /** Drags one of the two cut markers. */
    const startMarker = (event: ReactPointerEvent, which: 0 | 1) => {
        event.stopPropagation();
        if (event.button !== 0 || !range) return;
        // The other marker stays where it was when the drag started.
        const initial = range;
        drag(event, (e) => {
            const next: [number, number] = [...initial];
            next[which] = snap(timeAt(e.clientX), e);
            onRangeChange(next);
            onSeek(next[which]);
        });
    };

    const renderRow = <T extends TimedItem>(row: RowSpec<T>) => (
        <>
            <div className='pointer-events-none absolute inset-x-0 rounded bg-panel-2/70' style={{ top: row.top, height: ROW_HEIGHT }} />
            {timedSegments(clips, row.items).map(({ item, clipIndex, from, to, startsItem, endsItem }) => (
                <div
                    key={`${item.id}-${clipIndex}`}
                    className={cx(
                        'absolute flex items-center overflow-hidden rounded border text-[10px] font-medium',
                        item.id === row.selectedItemId ? `z-10 ${row.className.selected}` : row.className.idle
                    )}
                    style={{ top: row.top, height: ROW_HEIGHT, left: from * scale, width: Math.max(6, (to - from) * scale) }}
                    onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        row.onSelectItem(item.id);
                    }}
                    title={row.title(item)}
                >
                    <span className='pointer-events-none truncate px-2'>{row.label(item)}</span>
                    {startsItem && (
                        <div
                            className='absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/40'
                            onPointerDown={(e) => startItemEdge(e, row, item, clipIndex, 'start')}
                            title={`Drag to change when the ${row.kind} starts (hold ⌥ to skip snapping)`}
                        />
                    )}
                    {endsItem && (
                        <div
                            className='absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/40'
                            onPointerDown={(e) => startItemEdge(e, row, item, clipIndex, 'end')}
                            title={`Drag to change when the ${row.kind} ends (hold ⌥ to skip snapping)`}
                        />
                    )}
                </div>
            ))}
        </>
    );

    return (
        <div className='flex select-none'>
            {/* Lane labels */}
            <div className='relative w-8 shrink-0' style={{ height: RULER_HEIGHT + LANES_HEIGHT }}>
                {LANES.map((lane) => (
                    <div
                        key={lane.label}
                        className='absolute left-0 flex w-6 items-center justify-center rounded-md text-subtle'
                        style={{ top: RULER_HEIGHT + lane.top, height: lane.height }}
                        title={lane.label}
                        aria-label={lane.label}
                    >
                        {lane.icon}
                    </div>
                ))}
            </div>

            <div ref={viewportRef} className='min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-1'>
                <div style={{ width: total > 0 ? total * scale : contentWidth }}>
                    <Ruler total={total} scale={scale} onPointerDown={startScrub} />
                    <div ref={containerRef} className='relative' style={{ height: LANES_HEIGHT }} onPointerDown={startScrub}>
                        {clips.map((clip, index) => {
                            const left = starts[index] * scale;
                            const clipWidth = clipLength(clip) * scale;
                            const selected = clip.id === selectedId;
                            return (
                                <div key={clip.id}>
                                    <div
                                        className={cx(
                                            'absolute top-0 overflow-hidden rounded-md border-2 bg-panel-2',
                                            selected ? 'z-10 border-accent' : 'border-line hover:border-line-strong'
                                        )}
                                        style={{ left, width: Math.max(4, clipWidth - 2), height: CLIP_HEIGHT }}
                                        onPointerDown={(e) => {
                                            if (e.button === 0) onSelect(clip.id);
                                        }}
                                    >
                                        {thumbnails
                                            .filter((thumb) => thumb.time >= clip.start && thumb.time <= clip.end)
                                            .map((thumb) => (
                                                <img
                                                    key={thumb.time}
                                                    src={thumb.url}
                                                    draggable={false}
                                                    className='pointer-events-none absolute top-0 h-full w-auto opacity-80'
                                                    style={{ left: ((thumb.time - clip.start) / clip.speed) * scale }}
                                                />
                                            ))}
                                        {clip.speed !== 1 && (
                                            <span className='absolute bottom-1 right-2 rounded bg-black/70 px-1.5 text-[10px] font-medium text-white'>{clip.speed}×</span>
                                        )}
                                        <div
                                            className='absolute inset-y-0 left-0 cursor-ew-resize bg-accent/0 hover:bg-accent/60'
                                            style={{ width: HANDLE_WIDTH }}
                                            onPointerDown={(e) => startTrim(e, index, 'start')}
                                            title='Drag to trim the start'
                                        />
                                        <div
                                            className='absolute inset-y-0 right-0 cursor-ew-resize bg-accent/0 hover:bg-accent/60'
                                            style={{ width: HANDLE_WIDTH }}
                                            onPointerDown={(e) => startTrim(e, index, 'end')}
                                            title='Drag to trim the end (hold ⌥ to skip snapping)'
                                        />
                                    </div>
                                    {/* Audio for this clip */}
                                    <div
                                        className='absolute overflow-hidden rounded-md bg-lane-audio/10'
                                        style={{ left, width: Math.max(4, clipWidth - 2), top: AUDIO_TOP, height: AUDIO_HEIGHT }}
                                    >
                                        {waveform && <ClipWaveform peaks={waveform} clip={clip} width={Math.max(4, clipWidth - 2)} height={AUDIO_HEIGHT} scale={scale} />}
                                    </div>
                                </div>
                            );
                        })}
                        {renderRow<Zoom>({
                            top: ZOOM_TOP,
                            items: zooms,
                            selectedItemId: selectedZoomId,
                            onSelectItem: onSelectZoom,
                            onItemsChange: onZoomsChange,
                            kind: 'zoom',
                            label: (item) => `${item.scale.toFixed(1)}×`,
                            title: (item) => `Zoom ${item.scale.toFixed(1)}× (${item.mode === 'follow' ? 'follows the cursor' : 'fixed point'})`,
                            patch: { auto: false },
                            className: { idle: 'border-lane-zoom/60 bg-lane-zoom/35 text-fg hover:bg-lane-zoom/55', selected: 'border-fg bg-lane-zoom text-white' },
                        })}
                        {renderRow<TextOverlay>({
                            top: TEXT_TOP,
                            items: texts,
                            selectedItemId: selectedTextId,
                            onSelectItem: onSelectText,
                            onItemsChange: onTextsChange,
                            kind: 'text',
                            label: (text) => text.text.split('\n')[0] || 'Text',
                            title: (text) => `Text: ${text.text || 'empty'}`,
                            className: { idle: 'border-lane-text/60 bg-lane-text/30 text-fg hover:bg-lane-text/50', selected: 'border-fg bg-lane-text text-black' },
                        })}
                        {range && (
                            <>
                                <div
                                    className='pointer-events-none absolute -top-1 bottom-0 z-10 rounded-sm border-y-2 border-lane-cut bg-lane-cut/20'
                                    style={{ left: Math.min(...range) * scale, width: Math.abs(range[1] - range[0]) * scale }}
                                />
                                {range.map((t, which) => (
                                    <div
                                        key={which}
                                        className='absolute -top-2 bottom-0 z-30 -ml-2 w-4 cursor-ew-resize'
                                        style={{ left: t * scale }}
                                        onPointerDown={(e) => startMarker(e, which as 0 | 1)}
                                        title='Drag to choose the part to cut (hold ⌥ to skip snapping)'
                                    >
                                        <div className='absolute left-1/2 top-0 h-full w-1 -translate-x-1/2 rounded-full bg-lane-cut' />
                                        <div className='absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 rounded-full bg-lane-cut ring-2 ring-bg' />
                                    </div>
                                ))}
                            </>
                        )}
                        {snapLine !== null && (
                            <div className='pointer-events-none absolute -top-6 bottom-0 z-40 w-0 border-l border-dashed border-accent' style={{ left: snapLine * scale }} />
                        )}
                        <div ref={playheadRef} className='pointer-events-none absolute -top-6 bottom-0 z-20 w-0'>
                            <div className='absolute -left-[6px] top-0 h-3.5 w-3 rounded-b-[4px] rounded-t-sm bg-fg' />
                            <div className='absolute left-0 top-0 h-full w-px -translate-x-1/2 bg-fg' />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
});

/** The mixed audio envelope under one clip, drawn as centred bars. */
function ClipWaveform({ peaks, clip, width, height, scale }: { peaks: Float32Array; clip: Clip; width: number; height: number; scale: number }) {
    // One bar per 2px, but never more than 2000 bars per clip.
    const step = Math.max(2, width / 2000);
    const bars: string[] = [];
    const middle = height / 2;
    for (let x = step / 2; x < width; x += step) {
        const from = clip.start + ((x - step / 2) / scale) * clip.speed;
        const to = clip.start + ((x + step / 2) / scale) * clip.speed;
        const half = Math.max(0.5, peakBetween(peaks, from, to) * (height / 2 - 3));
        bars.push(`M${x.toFixed(1)} ${(middle - half).toFixed(1)}V${(middle + half).toFixed(1)}`);
    }
    return (
        <svg className='pointer-events-none absolute inset-0 text-lane-audio' width={width} height={height} aria-hidden>
            <path d={bars.join('')} stroke='currentColor' strokeWidth={Math.min(1.5, step * 0.7)} strokeLinecap='round' />
        </svg>
    );
}

function Ruler({ total, scale, onPointerDown }: { total: number; scale: number; onPointerDown: (e: ReactPointerEvent) => void }) {
    if (scale <= 0) return <div style={{ height: RULER_HEIGHT }} />;
    // Label roughly every 80px on a round number of seconds, with minor ticks in between.
    const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * scale >= 80) ?? 600;
    const minor = step / 5;
    const marks: number[] = [];
    for (let t = 0; t <= total + 0.001; t += step) marks.push(t);
    const ticks: number[] = [];
    if (minor * scale >= 8) for (let t = 0; t <= total + 0.001; t += minor) ticks.push(t);
    const label = (t: number) => (step < 1 ? `${formatDuration(t)}.${Math.round((t % 1) * 100).toString().padStart(2, '0')}` : formatDuration(t));
    return (
        <div className='relative cursor-pointer text-[10px] text-subtle' style={{ height: RULER_HEIGHT }} onPointerDown={onPointerDown}>
            {ticks.map((t) => (
                <span key={`tick-${t}`} className='absolute bottom-0 h-1.5 w-px bg-line-strong' style={{ left: t * scale }} />
            ))}
            {marks.map((t) => (
                <span key={t} className='absolute bottom-0 h-2.5 w-px bg-muted' style={{ left: t * scale }} />
            ))}
            {marks.map((t) => (
                <span key={`label-${t}`} className='absolute top-0.5 -translate-x-1/2 font-mono' style={{ left: t * scale }}>
                    {label(t)}
                </span>
            ))}
        </div>
    );
}
