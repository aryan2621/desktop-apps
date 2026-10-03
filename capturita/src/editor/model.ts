import type { CursorData, Project } from '../lib/api';

/**
 * Everything the user changes in the editor. Saved as edit.json next to the recording;
 * the recorded files themselves are never modified.
 */
export interface Edit {
    version: 1;
    /** Kept parts of the recording, in order, as source-time ranges. Gaps between clips are cuts. */
    clips: Clip[];
    background: Background;
    /** Space around the screen, as a fraction of the shorter side of the frame. */
    padding: number;
    /** Corner radius of the screen, as a fraction of the frame width. */
    radius: number;
    /** 0 (none) to 1 (strong). */
    shadow: number;
    /** Visible part of the screen, normalized to the recorded area. */
    crop: NormalizedRect;
    aspect: Aspect;
    camera: CameraLayout;
    cursor: CursorStyle;
    zooms: Zoom[];
    /** Zoom amount used for auto-zoom and newly added zooms. */
    zoomScale: number;
    texts: TextOverlay[];
    /** Parts of the screen hidden for privacy (pixelated, blurred or covered). */
    hides: HideRegion[];
    captions: Captions;
    audio: AudioMix;
}

export type HideStyle = 'pixelate' | 'blur' | 'solid';

export const HIDE_STYLES: { value: HideStyle; label: string; hint: string }[] = [
    { value: 'pixelate', label: 'Pixelate', hint: 'Large blocks: the usual "censored" look' },
    { value: 'blur', label: 'Blur', hint: 'Soft blur; fine for faces and photos' },
    { value: 'solid', label: 'Solid', hint: 'A plain box. The only fully safe choice for passwords and keys' },
];

/**
 * A part of the recording hidden for privacy. Times are source times, like zooms; the box is
 * normalized to the whole recorded screen (like the crop), so it stays on the content while
 * zooming and cropping.
 */
export interface HideRegion extends NormalizedRect {
    id: string;
    start: number;
    end: number;
    style: HideStyle;
}

/** One spoken word with its timing (source seconds). */
export interface CaptionWord {
    start: number;
    end: number;
    text: string;
}

/** One caption on screen. Times are source times; `words` drive the word highlight. */
export interface Caption {
    id: string;
    start: number;
    end: number;
    text: string;
    words: CaptionWord[];
}

export type CaptionBackground = 'box' | 'shadow' | 'none';

export interface CaptionStyle {
    font: FontKey;
    /** Font size as a fraction of the frame's shorter side. */
    size: number;
    color: string;
    bold: boolean;
    background: CaptionBackground;
    position: 'bottom' | 'top';
    /** Colour of the word being spoken, or null for no highlight. */
    highlight: string | null;
}

export interface Captions {
    /** Burn the captions into the video. */
    visible: boolean;
    /** Language spoken ("auto" detects it). */
    language: string;
    style: CaptionStyle;
    items: Caption[];
    /** "um"/"uh" left out of the captions, kept with their timings so they can be cut out. */
    fillers?: CaptionWord[];
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
    font: 'system',
    size: 0.05,
    color: '#ffffff',
    bold: true,
    background: 'box',
    position: 'bottom',
    highlight: '#ffd200',
};

/** Text shown over the video. Times are source times, like zooms. */
export interface TextOverlay {
    id: string;
    start: number;
    end: number;
    text: string;
    /** Centre of the text, normalized to the output frame. */
    x: number;
    y: number;
    /** Font size as a fraction of the frame height. */
    size: number;
    color: string;
    bold: boolean;
    background: 'none' | 'box';
    font: FontKey;
    /** How the text enters and leaves. */
    animation: TextAnimation;
}

export type TextAnimation = 'none' | 'fade' | 'rise' | 'pop' | 'slide' | 'blur' | 'typewriter' | 'words';

export const TEXT_ANIMATIONS: { value: TextAnimation; label: string; hint: string }[] = [
    { value: 'none', label: 'None', hint: 'Appears and disappears instantly' },
    { value: 'fade', label: 'Fade', hint: 'Fades in and out' },
    { value: 'rise', label: 'Rise', hint: 'Fades in while rising a little' },
    { value: 'pop', label: 'Pop', hint: 'Springs in from smaller' },
    { value: 'slide', label: 'Slide', hint: 'Slides in from the left' },
    { value: 'blur', label: 'Blur', hint: 'Comes into focus from a blur' },
    { value: 'typewriter', label: 'Type', hint: 'Types out letter by letter' },
    { value: 'words', label: 'Words', hint: 'Reveals one word at a time' },
];

export type FontKey = 'system' | 'rounded' | 'serif' | 'mono' | 'avenir' | 'futura' | 'georgia' | 'marker';

/** macOS fonts for text overlays, with fallbacks. The same stacks are used for preview and export. */
export const FONTS: { value: FontKey; label: string; stack: string }[] = [
    { value: 'system', label: 'SF Pro', stack: '-apple-system, "SF Pro Display", system-ui, sans-serif' },
    { value: 'rounded', label: 'SF Rounded', stack: 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif' },
    { value: 'serif', label: 'New York', stack: 'ui-serif, "New York", Georgia, serif' },
    { value: 'mono', label: 'SF Mono', stack: 'ui-monospace, "SF Mono", Menlo, monospace' },
    { value: 'avenir', label: 'Avenir Next', stack: '"Avenir Next", Avenir, sans-serif' },
    { value: 'futura', label: 'Futura', stack: 'Futura, "Century Gothic", sans-serif' },
    { value: 'georgia', label: 'Georgia', stack: 'Georgia, serif' },
    { value: 'marker', label: 'Marker Felt', stack: '"Marker Felt", "Comic Sans MS", cursive' },
];

export const fontStack = (font: FontKey) => (FONTS.find((f) => f.value === font) ?? FONTS[0]).stack;

export interface TrackLevel {
    /** 0 to 2 (200%). */
    volume: number;
    muted: boolean;
}

export interface AudioMix {
    system: TrackLevel;
    microphone: TrackLevel;
    /** Seconds of fade at the start and end of the whole video. */
    fadeIn: number;
    fadeOut: number;
    /** Background music, played along the edited timeline. */
    music: MusicTrack | null;
}

/** A song copied into the project folder. */
export interface MusicTrack extends TrackLevel {
    /** File name inside the project folder (music.mp3, …). */
    file: string;
    /** The original file name, for display. */
    name: string;
    /** Start this many seconds into the song. */
    offset: number;
    /** Repeat the song if the video is longer. */
    loop: boolean;
}

export const DEFAULT_MUSIC_VOLUME = 0.35;

/** A stretch of the recording shown zoomed in. Times are source times, so cuts don't move it. */
export interface Zoom {
    id: string;
    start: number;
    end: number;
    /** 1.2 to 4. */
    scale: number;
    /** Follow the cursor, or stay on a fixed point. */
    mode: 'follow' | 'fixed';
    /** Fixed focus point, normalized to the (cropped) screen. */
    x: number;
    y: number;
    /** Created by auto-zoom (replaced when auto-zoom runs again). */
    auto: boolean;
}

export interface Clip {
    id: string;
    start: number;
    end: number;
    speed: number;
}

export interface NormalizedRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type Aspect = 'auto' | '16:9' | '9:16' | '1:1' | '4:5';

export type Background = { type: 'gradient'; from: string; to: string; angle: number } | { type: 'color'; color: string };

export type CameraCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface CameraLayout {
    visible: boolean;
    corner: CameraCorner;
    /** Diameter as a fraction of the shorter side of the frame. */
    size: number;
    shape: 'circle' | 'rounded';
}

export type CursorShape = 'arrow' | 'hand' | 'dot';
export type ClickStyle = 'ripple' | 'pulse' | 'none';

export interface CursorStyle {
    visible: boolean;
    shape: CursorShape;
    /** Multiplier on the natural cursor size. */
    size: number;
    /** 0 draws the raw movement, 1 is the smoothest. */
    smoothing: number;
    /** What appears where the mouse was clicked. */
    clickStyle: ClickStyle;
    /** The cursor dips briefly on each click, like a button being pressed. */
    pressEffect: boolean;
    clickSound: boolean;
    /** A soft tick, or a two-part mechanical mouse click (both synthesized). */
    clickSoundType: ClickSoundType;
    /** 0 to 1. */
    clickVolume: number;
}

export type ClickSoundType = 'tick' | 'mouse';

export const ASPECTS: { value: Aspect; label: string }[] = [
    { value: 'auto', label: 'Original' },
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '1:1', label: '1:1' },
    { value: '4:5', label: '4:5' },
];

export const GRADIENTS: Background[] = [
    { type: 'gradient', from: '#7c5cff', to: '#ff6ec4', angle: 135 },
    { type: 'gradient', from: '#0f2027', to: '#2c5364', angle: 160 },
    { type: 'gradient', from: '#f7971e', to: '#ffd200', angle: 135 },
    { type: 'gradient', from: '#11998e', to: '#38ef7d', angle: 135 },
    { type: 'gradient', from: '#fc466b', to: '#3f5efb', angle: 120 },
    { type: 'gradient', from: '#232526', to: '#414345', angle: 180 },
    { type: 'gradient', from: '#e0eafc', to: '#cfdef3', angle: 135 },
    { type: 'gradient', from: '#1a2a6c', to: '#fdbb2d', angle: 135 },
];

export const MIN_CLIP = 0.2;
export const MIN_ZOOM = 0.5;
export const DEFAULT_ZOOM_SCALE = 1.8;

export const newId = () => Math.random().toString(36).slice(2, 10);

export function defaultEdit(project: Project): Edit {
    return {
        version: 1,
        clips: [{ id: newId(), start: 0, end: sourceDuration(project), speed: 1 }],
        background: GRADIENTS[0],
        padding: 0.06,
        radius: 0.012,
        shadow: 0.5,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        aspect: 'auto',
        camera: { visible: true, corner: 'bottom-left', size: 0.24, shape: 'circle' },
        cursor: { visible: true, shape: 'arrow', size: 1, smoothing: 0.5, clickStyle: 'ripple', pressEffect: true, clickSound: false, clickSoundType: 'tick', clickVolume: 0.6 },
        zooms: [],
        zoomScale: DEFAULT_ZOOM_SCALE,
        texts: [],
        hides: [],
        captions: { visible: true, language: 'auto', style: DEFAULT_CAPTION_STYLE, items: [] },
        audio: { system: { volume: 1, muted: false }, microphone: { volume: 1, muted: false }, fadeIn: 0, fadeOut: 0, music: null },
    };
}

/** Fills in anything missing from an older or partial edit.json. */
export function normalizeEdit(project: Project, raw: unknown): Edit {
    const base = defaultEdit(project);
    if (!raw || typeof raw !== 'object') return base;
    const edit = { ...base, ...(raw as Partial<Edit>) };
    edit.camera = { ...base.camera, ...edit.camera };
    edit.cursor = { ...base.cursor, ...edit.cursor };
    // Edits saved before click styles existed had an on/off `clickEffect`.
    const legacy = (raw as { cursor?: { clickEffect?: boolean; clickStyle?: ClickStyle } }).cursor;
    if (legacy && legacy.clickStyle === undefined && legacy.clickEffect === false) edit.cursor.clickStyle = 'none';
    delete (edit.cursor as Partial<{ clickEffect: boolean }>).clickEffect;
    edit.zoomScale = edit.zoomScale || DEFAULT_ZOOM_SCALE;
    edit.texts = Array.isArray(edit.texts)
        ? edit.texts.filter((t) => t.end - t.start >= MIN_ZOOM / 2).map((t) => ({ ...t, font: t.font ?? 'system', animation: t.animation ?? 'rise' }))
        : [];
    edit.hides = Array.isArray(edit.hides) ? edit.hides.filter((h) => h.end - h.start >= MIN_ZOOM / 2) : [];
    edit.captions = {
        ...base.captions,
        ...edit.captions,
        style: { ...base.captions.style, ...edit.captions?.style },
        items: Array.isArray(edit.captions?.items) ? edit.captions.items : [],
    };
    edit.audio = {
        ...base.audio,
        ...edit.audio,
        system: { ...base.audio.system, ...edit.audio?.system },
        microphone: { ...base.audio.microphone, ...edit.audio?.microphone },
        music: edit.audio?.music ?? null,
    };
    edit.crop = { ...base.crop, ...edit.crop };
    edit.zooms = Array.isArray(edit.zooms) ? edit.zooms.filter((z) => z.end - z.start >= MIN_ZOOM / 2) : [];
    const duration = sourceDuration(project);
    edit.clips = (edit.clips ?? [])
        .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(duration, c.end), speed: c.speed || 1 }))
        .filter((c) => c.end - c.start >= MIN_CLIP / 2);
    if (edit.clips.length === 0) edit.clips = base.clips;
    return edit;
}

export function sourceDuration(project: Project) {
    return project.duration;
}

// ---- Timeline math: output time (what the viewer sees) ↔ source time (the recording) ----

export const clipLength = (clip: Clip) => (clip.end - clip.start) / clip.speed;

export const totalDuration = (clips: Clip[]) => clips.reduce((sum, clip) => sum + clipLength(clip), 0);

/** Output time at which each clip starts. */
export function clipStarts(clips: Clip[]) {
    const starts: number[] = [];
    let t = 0;
    for (const clip of clips) {
        starts.push(t);
        t += clipLength(clip);
    }
    return starts;
}

export interface Position {
    index: number;
    clip: Clip;
    /** Source time. */
    source: number;
}

export function positionAt(clips: Clip[], outputTime: number): Position {
    const starts = clipStarts(clips);
    for (let index = clips.length - 1; index >= 0; index--) {
        if (outputTime >= starts[index] || index === 0) {
            const clip = clips[index];
            const source = Math.min(clip.end, clip.start + Math.max(0, outputTime - starts[index]) * clip.speed);
            return { index, clip, source };
        }
    }
    const clip = clips[0];
    return { index: 0, clip, source: clip.start };
}

/** Output time of a source time inside a given clip. */
export function outputTimeOf(clips: Clip[], index: number, source: number) {
    const clip = clips[index];
    return clipStarts(clips)[index] + (source - clip.start) / clip.speed;
}

export function splitAt(clips: Clip[], outputTime: number): { clips: Clip[]; selected: string } | null {
    const { index, clip, source } = positionAt(clips, outputTime);
    if (source - clip.start < MIN_CLIP || clip.end - source < MIN_CLIP) return null;
    const left = { ...clip, end: source };
    const right = { ...clip, id: newId(), start: source };
    return { clips: [...clips.slice(0, index), left, right, ...clips.slice(index + 1)], selected: right.id };
}

/**
 * Cuts out everything between two output times, even across several clips.
 * Returns null if nothing would be left.
 */
export function removeRange(clips: Clip[], from: number, to: number): Clip[] | null {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const starts = clipStarts(clips);
    const result: Clip[] = [];
    clips.forEach((clip, index) => {
        const clipFrom = starts[index];
        const clipTo = clipFrom + clipLength(clip);
        const cutFrom = Math.max(a, clipFrom);
        const cutTo = Math.min(b, clipTo);
        if (cutTo <= cutFrom) {
            result.push(clip);
            return;
        }
        const sourceFrom = clip.start + (cutFrom - clipFrom) * clip.speed;
        const sourceTo = clip.start + (cutTo - clipFrom) * clip.speed;
        const keepLeft = sourceFrom - clip.start >= MIN_CLIP / 2;
        if (keepLeft) result.push({ ...clip, end: sourceFrom });
        if (clip.end - sourceTo >= MIN_CLIP / 2) result.push({ ...clip, id: keepLeft ? newId() : clip.id, start: sourceTo });
    });
    return result.length > 0 ? result : null;
}

export function removeClip(clips: Clip[], id: string) {
    if (clips.length <= 1) return clips;
    return clips.filter((clip) => clip.id !== id);
}

/** Limits for dragging a clip edge: it can't pass its neighbours or get shorter than MIN_CLIP. */
export function edgeLimits(clips: Clip[], index: number, edge: 'start' | 'end', duration: number) {
    const clip = clips[index];
    if (edge === 'start') return { min: index > 0 ? clips[index - 1].end : 0, max: clip.end - MIN_CLIP };
    return { min: clip.start + MIN_CLIP, max: index < clips.length - 1 ? clips[index + 1].start : duration };
}

export function aspectRatio(edit: Edit, project: Project) {
    if (edit.aspect === 'auto') {
        const { width, height } = project.tracks.screen;
        return (width * edit.crop.width) / (height * edit.crop.height);
    }
    const [w, h] = edit.aspect.split(':').map(Number);
    return w / h;
}

// ---- Zoom ----

/** How long zooming in or out takes, in seconds of the recording. */
export const ZOOM_TRANSITION = 0.6;
/** Clicks closer together than this share one zoom. */
const CLICK_GROUP_GAP = 3;
const ZOOM_LEAD_IN = 0.8;
const ZOOM_HOLD = 1.6;

/** Zoom regions around groups of clicks, like a person editing the video would add them. */
export function autoZooms(cursor: CursorData, duration: number, scale = DEFAULT_ZOOM_SCALE): Zoom[] {
    const clicks = cursor.clicks.map(([t]) => t).sort((a, b) => a - b);
    const groups: [number, number][] = [];
    for (const t of clicks) {
        const last = groups[groups.length - 1];
        if (last && t - last[1] < CLICK_GROUP_GAP) last[1] = t;
        else groups.push([t, t]);
    }
    const zooms: Zoom[] = [];
    for (const [first, last] of groups) {
        const start = Math.max(0, first - ZOOM_LEAD_IN);
        const end = Math.min(duration, last + ZOOM_HOLD);
        const previous = zooms[zooms.length - 1];
        // Merge with the previous zoom rather than zooming out for a split second.
        if (previous && start - previous.end < ZOOM_TRANSITION * 2) {
            previous.end = end;
            continue;
        }
        if (end - start >= MIN_ZOOM) zooms.push({ id: newId(), start, end, scale, mode: 'follow', x: 0.5, y: 0.5, auto: true });
    }
    return zooms;
}

const smoothstep = (x: number) => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
};

/**
 * How far a zoom is in at source time t: it eases in over the first ZOOM_TRANSITION seconds of
 * the zoom and out over the last, so the zoom never reaches outside its block on the timeline.
 */
export function zoomAmount(zoom: Zoom, t: number) {
    const transition = Math.min(ZOOM_TRANSITION, (zoom.end - zoom.start) / 2);
    return Math.min(smoothstep((t - zoom.start) / transition), smoothstep((zoom.end - t) / transition));
}

export interface TimedItem {
    id: string;
    start: number;
    end: number;
}

/** Pieces of each timed item (zoom, text) as they appear on the edited timeline; an item can span a cut. */
export function timedSegments<T extends TimedItem>(clips: Clip[], items: T[]) {
    const starts = clipStarts(clips);
    const segments: { item: T; clipIndex: number; from: number; to: number; startsItem: boolean; endsItem: boolean }[] = [];
    for (const zoom of items) {
        clips.forEach((clip, clipIndex) => {
            const a = Math.max(zoom.start, clip.start);
            const b = Math.min(zoom.end, clip.end);
            if (b <= a) return;
            segments.push({
                item: zoom,
                clipIndex,
                from: starts[clipIndex] + (a - clip.start) / clip.speed,
                to: starts[clipIndex] + (b - clip.start) / clip.speed,
                startsItem: a === zoom.start,
                endsItem: b === zoom.end,
            });
        });
    }
    return segments;
}

// ---- Text ----

export const TEXT_FADE = 0.3;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
/** Overshoots slightly before settling, for a springy "pop". */
const easeOutBack = (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;

/** Where a text is in its animation at time `t` (source seconds). */
export interface TextFrame {
    /** Overall opacity. */
    alpha: number;
    /** Offset as a fraction of the font size (x) and of the font size (y). */
    dx: number;
    dy: number;
    scale: number;
    /** Blur radius as a fraction of the font size. */
    blur: number;
    /** 0 → 1: share of characters (typewriter) or words (words) revealed. */
    reveal: number;
    /** Typewriter caret is shown while typing. */
    caret: boolean;
}

/** Time to type or reveal a text: proportional to its length, but at most 60% of its duration. */
function revealDuration(text: TextOverlay) {
    const units = text.animation === 'words' ? text.text.split(/\s+/).filter(Boolean).length : text.text.length;
    const perUnit = text.animation === 'words' ? 0.18 : 0.045;
    return Math.min(units * perUnit, (text.end - text.start) * 0.6, 3);
}

export function textFrame(text: TextOverlay, t: number): TextFrame {
    const frame: TextFrame = { alpha: 0, dx: 0, dy: 0, scale: 1, blur: 0, reveal: 1, caret: false };
    if (t < text.start || t > text.end) return frame;
    const length = text.end - text.start;
    const fade = Math.min(TEXT_FADE, length / 2);
    const enter = clamp01((t - text.start) / fade);
    const exit = clamp01((text.end - t) / fade);
    const both = Math.min(smoothstep(enter), smoothstep(exit));
    frame.alpha = both;
    switch (text.animation) {
        case 'none':
            frame.alpha = 1;
            break;
        case 'fade':
            break;
        case 'rise':
            frame.dy = (1 - both) * 0.25;
            break;
        case 'pop': {
            const pop = clamp01((t - text.start) / Math.min(0.45, length / 2));
            frame.alpha = Math.min(clamp01(pop * 2), smoothstep(exit));
            frame.scale = enter < 1 ? 0.6 + 0.4 * easeOutBack(pop) : 1 - (1 - exit) * 0.08;
            break;
        }
        case 'slide': {
            const slide = clamp01((t - text.start) / Math.min(0.5, length / 2));
            frame.dx = -(1 - easeOutCubic(slide)) * 1.2;
            frame.alpha = Math.min(clamp01(slide * 1.6), smoothstep(exit));
            break;
        }
        case 'blur':
            frame.blur = (1 - both) * 0.35;
            break;
        case 'typewriter':
        case 'words': {
            const duration = revealDuration(text);
            frame.reveal = duration > 0 ? clamp01((t - text.start) / duration) : 1;
            frame.alpha = smoothstep(exit);
            frame.caret = text.animation === 'typewriter' && frame.reveal < 1;
            break;
        }
    }
    return frame;
}

/** 0 → 1 → 0 visibility of a text over its lifetime (used for hit-testing and the timeline). */
export function textAmount(text: TextOverlay, t: number) {
    return textFrame(text, t).alpha;
}

// ---- Snapping ----

/**
 * Snaps `value` to the nearest target within `threshold` (all in output seconds).
 * Returns the value and the target it snapped to, if any.
 */
export function snapTo(value: number, targets: number[], threshold: number): { value: number; snapped: number | null } {
    let best: number | null = null;
    for (const target of targets) {
        if (Math.abs(target - value) <= threshold && (best === null || Math.abs(target - value) < Math.abs(best - value))) best = target;
    }
    return best === null ? { value, snapped: null } : { value: best, snapped: best };
}

// ---- Hide regions ----

export const hideActive = (hide: HideRegion, t: number) => t >= hide.start && t <= hide.end;

// ---- Captions ----

/** Longest caption line, in characters, before starting a new caption. */
const CAPTION_CHARS = 42;
/** A pause longer than this starts a new caption. */
const CAPTION_GAP = 0.7;
const CAPTION_MAX_SECONDS = 5;
/** Hesitations dropped from captions. */
export const FILLER = /^(u+[hm]+|e+r+m*|hm+|mm+)[,.!?]*$/i;

/**
 * Groups transcribed words into captions the way subtitles are usually cut: at most ~two short
 * lines, a new caption after a pause or the end of a sentence, never longer than a few seconds.
 */
export function groupCaptions(words: CaptionWord[], removeFillers = true): Caption[] {
    const captions: Caption[] = [];
    let current: CaptionWord[] = [];
    const flush = () => {
        if (current.length === 0) return;
        captions.push({
            id: newId(),
            start: current[0].start,
            end: current[current.length - 1].end,
            text: current.map((w) => w.text).join(' '),
            words: current,
        });
        current = [];
    };
    for (const word of words) {
        const text = word.text.trim();
        if (!text || (removeFillers && FILLER.test(text))) continue;
        const last = current[current.length - 1];
        if (last) {
            const length = current.reduce((n, w) => n + w.text.length + 1, 0) + text.length;
            const sentenceEnded = /[.!?]$/.test(last.text) && current.length >= 3;
            if (word.start - last.end > CAPTION_GAP || length > CAPTION_CHARS || sentenceEnded || word.end - current[0].start > CAPTION_MAX_SECONDS) flush();
        }
        current.push({ ...word, text });
    }
    flush();
    return captions;
}

/**
 * After the text of a caption is edited, spreads its new words over the caption's time in
 * proportion to their length, so the word highlight still roughly follows the speech.
 */
export function retimeCaption(caption: Caption, text: string): Caption {
    const tokens = text.split(/\s+/).filter(Boolean);
    const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
    const duration = caption.end - caption.start;
    let t = caption.start;
    const words = tokens.map((token) => {
        const length = (token.length / total) * duration;
        const word = { start: t, end: t + length, text: token };
        t += length;
        return word;
    });
    return { ...caption, text, words };
}

/** The caption on screen at source time t, if any. */
export const captionAt = (captions: Caption[], t: number) => captions.find((c) => t >= c.start && t < c.end) ?? null;

const srtTime = (seconds: number) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const pad = (n: number, width = 2) => n.toString().padStart(width, '0');
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** Captions as an .srt file on the edited timeline (cuts and speed applied). */
export function toSrt(clips: Clip[], captions: Caption[]) {
    const cues = timedSegments(clips, captions)
        .filter((s) => s.to - s.from >= 0.2 && s.item.text.trim())
        .sort((a, b) => a.from - b.from);
    return cues.map((s, i) => `${i + 1}\n${srtTime(s.from)} --> ${srtTime(s.to)}\n${s.item.text.trim()}\n`).join('\n');
}

// ---- Edits in source time (used by AI editing) ----

/** Removes source time a..b from the kept clips. Returns the clips unchanged if nothing would be left. */
export function cutSource(clips: Clip[], a: number, b: number): Clip[] {
    const out: Clip[] = [];
    for (const clip of clips) {
        if (b <= clip.start || a >= clip.end) {
            out.push(clip);
            continue;
        }
        const keepLeft = a - clip.start >= MIN_CLIP / 2;
        if (keepLeft) out.push({ ...clip, end: a });
        if (clip.end - b >= MIN_CLIP / 2) out.push({ ...clip, id: keepLeft ? newId() : clip.id, start: b });
    }
    return out.length > 0 ? out : clips;
}

/** Plays source time a..b at `speed`, splitting the clips around it. */
export function speedSource(clips: Clip[], a: number, b: number, speed: number): Clip[] {
    const out: Clip[] = [];
    for (const clip of clips) {
        if (b <= clip.start || a >= clip.end) {
            out.push(clip);
            continue;
        }
        const from = Math.max(a, clip.start);
        const to = Math.min(b, clip.end);
        const keepLeft = from - clip.start >= MIN_CLIP / 2;
        if (keepLeft) out.push({ ...clip, end: from });
        out.push({ ...clip, id: keepLeft ? newId() : clip.id, start: keepLeft ? from : clip.start, end: clip.end - to < MIN_CLIP / 2 ? clip.end : to, speed });
        if (clip.end - to >= MIN_CLIP / 2) out.push({ ...clip, id: newId(), start: to });
    }
    return out;
}
