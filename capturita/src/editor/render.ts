import type { CursorData, Project } from '../lib/api';
import { fontStack, textAmount, zoomAmount, type Background, type CursorShape, type Edit, type NormalizedRect, type TextOverlay } from './model';

/** Cursor height in screen points before scaling. */
const CURSOR_POINTS = 22;
const CLICK_DURATION = 0.45;
/** The cursor dips to this size on a click, then springs back. */
const PRESS_DEPTH = 0.22;
const PRESS_IN = 0.08;
const PRESS_OUT = 0.22;
const FULL: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
/** Longest cursor smoothing window, in seconds (at smoothing = 1). */
const MAX_SMOOTHING_WINDOW = 0.3;
/** How far around t a followed zoom looks when centring on the cursor, so the camera glides. */
const FOLLOW_WINDOW = 0.8;

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A decoded video frame: a <video> element in the editor, or a decoded sample during export. */
export interface FrameSource {
    image: CanvasImageSource;
    width: number;
    height: number;
}

/** The current frame of a <video>, or null before it has one. */
export function videoFrame(video: HTMLVideoElement | null): FrameSource | null {
    return video && video.videoWidth > 0 ? { image: video, width: video.videoWidth, height: video.videoHeight } : null;
}

export interface FrameInputs {
    edit: Edit;
    project: Project;
    screen: FrameSource | null;
    camera: FrameSource | null;
    /** Whether the camera track has a frame at this source time. */
    cameraActive: boolean;
    cursor: CursorData | null;
    /** Source time (seconds into the recording). */
    time: number;
    /** Crop editing shows the whole recording so the crop box can be moved over it. */
    ignoreCrop?: boolean;
}

/** Where the screen sits inside a frame of the given size. */
export function layoutFrame(edit: Edit, project: Project, width: number, height: number, ignoreCrop = false): Rect {
    const crop = ignoreCrop ? FULL : edit.crop;
    const { screen } = project.tracks;
    const contentAspect = (screen.width * crop.width) / (screen.height * crop.height);
    const pad = edit.padding * Math.min(width, height);
    const availableWidth = Math.max(1, width - pad * 2);
    const availableHeight = Math.max(1, height - pad * 2);
    let w = availableWidth;
    let h = w / contentAspect;
    if (h > availableHeight) {
        h = availableHeight;
        w = h * contentAspect;
    }
    return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/**
 * The part of the (cropped) screen in view at source time t, normalized to the cropped screen.
 * The strongest active zoom wins; its focus eases towards the cursor (or its fixed point).
 */
export function zoomViewport(edit: Edit, cursor: CursorData | null, t: number, crop: NormalizedRect): NormalizedRect {
    let best = null as { amount: number; scale: number; x: number; y: number } | null;
    for (const zoom of edit.zooms) {
        const amount = zoomAmount(zoom, t);
        if (amount <= 0 || (best && amount * (zoom.scale - 1) <= best.amount * (best.scale - 1))) continue;
        let x = zoom.x;
        let y = zoom.y;
        if (zoom.mode === 'follow' && cursor) {
            const point = smoothedCursor(cursor, t, FOLLOW_WINDOW);
            if (point) {
                x = (point.x - crop.x) / crop.width;
                y = (point.y - crop.y) / crop.height;
            }
        }
        best = { amount, scale: zoom.scale, x, y };
    }
    if (!best) return FULL;
    const scale = 1 + (best.scale - 1) * best.amount;
    const size = 1 / scale;
    // Blend the focus from the centre so zooming in and out doesn't jump sideways.
    const cx = 0.5 + (best.x - 0.5) * best.amount;
    const cy = 0.5 + (best.y - 0.5) * best.amount;
    return {
        x: Math.min(1 - size, Math.max(0, cx - size / 2)),
        y: Math.min(1 - size, Math.max(0, cy - size / 2)),
        width: size,
        height: size,
    };
}

export function drawFrame(ctx: CanvasRenderingContext2D, width: number, height: number, inputs: FrameInputs): Rect {
    const { edit, project, screen, camera, cursor, time } = inputs;
    const baseCrop = inputs.ignoreCrop ? FULL : edit.crop;
    // Zooming narrows the visible part of the screen further.
    const view = inputs.ignoreCrop ? FULL : zoomViewport(edit, cursor, time, baseCrop);
    const crop = {
        x: baseCrop.x + view.x * baseCrop.width,
        y: baseCrop.y + view.y * baseCrop.height,
        width: baseCrop.width * view.width,
        height: baseCrop.height * view.height,
    };
    // Layout uses the un-zoomed crop so the frame keeps its size while zooming.
    const content = layoutFrame(edit, project, width, height, inputs.ignoreCrop);
    const radius = Math.min(edit.radius * width, content.width / 2, content.height / 2);

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    fillBackground(ctx, edit.background, width, height);

    // Screen with its shadow.
    if (edit.shadow > 0) {
        ctx.save();
        ctx.shadowColor = `rgba(0, 0, 0, ${0.25 + edit.shadow * 0.35})`;
        ctx.shadowBlur = edit.shadow * Math.min(width, height) * 0.06;
        ctx.shadowOffsetY = edit.shadow * Math.min(width, height) * 0.012;
        ctx.fillStyle = '#000';
        roundRect(ctx, content, radius);
        ctx.fill();
        ctx.restore();
    }
    ctx.save();
    roundRect(ctx, content, radius);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(content.x, content.y, content.width, content.height);
    if (screen) {
        ctx.drawImage(
            screen.image,
            crop.x * screen.width,
            crop.y * screen.height,
            crop.width * screen.width,
            crop.height * screen.height,
            content.x,
            content.y,
            content.width,
            content.height
        );
    }

    // Cursor and clicks, mapped from the recorded area into the cropped screen.
    if (cursor && edit.cursor.visible) {
        const areaPoints = project.source.area.width * crop.width;
        const scale = content.width / areaPoints;
        const toFrame = (x: number, y: number) => ({
            x: content.x + ((x - crop.x) / crop.width) * content.width,
            y: content.y + ((y - crop.y) / crop.height) * content.height,
        });
        const unit = scale * edit.cursor.size;
        let lastClick = -Infinity;
        for (const [t, x, y] of cursor.clicks) {
            if (t <= time) lastClick = Math.max(lastClick, t);
            if (edit.cursor.clickStyle === 'none' || time < t || time >= t + CLICK_DURATION) continue;
            const progress = (time - t) / CLICK_DURATION;
            const point = toFrame(x, y);
            ctx.beginPath();
            if (edit.cursor.clickStyle === 'ripple') {
                ctx.arc(point.x, point.y, (8 + progress * 22) * unit, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(124, 92, 255, ${1 - progress})`;
                ctx.lineWidth = Math.max(1.5, 2.5 * scale);
                ctx.stroke();
            } else {
                ctx.arc(point.x, point.y, (7 + progress * 9) * unit, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(124, 92, 255, ${0.5 * (1 - progress)})`;
                ctx.fill();
            }
        }
        const pointer = smoothedCursor(cursor, time, edit.cursor.smoothing * MAX_SMOOTHING_WINDOW);
        if (pointer) {
            const point = toFrame(pointer.x, pointer.y);
            const press = edit.cursor.pressEffect ? pressAmount(time - lastClick) : 0;
            drawCursor(ctx, edit.cursor.shape, point.x, point.y, CURSOR_POINTS * unit * (1 - PRESS_DEPTH * press));
        }
    }
    ctx.restore();

    // Camera bubble.
    if (camera && inputs.cameraActive && edit.camera.visible) {
        const short = Math.min(width, height);
        const size = edit.camera.size * short;
        const margin = Math.max(edit.padding * short * 0.6, short * 0.03);
        const left = edit.camera.corner.endsWith('left');
        const top = edit.camera.corner.startsWith('top');
        const box = { x: left ? margin : width - margin - size, y: top ? margin : height - margin - size, width: size, height: size };
        const bubbleRadius = edit.camera.shape === 'circle' ? size / 2 : size * 0.18;

        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
        ctx.shadowBlur = size * 0.12;
        ctx.fillStyle = '#000';
        roundRect(ctx, box, bubbleRadius);
        ctx.fill();
        ctx.restore();

        ctx.save();
        roundRect(ctx, box, bubbleRadius);
        ctx.clip();
        // Centre square of the camera image, mirrored like a selfie view.
        const side = Math.min(camera.width, camera.height);
        ctx.translate(box.x + size, box.y);
        ctx.scale(-1, 1);
        ctx.drawImage(camera.image, (camera.width - side) / 2, (camera.height - side) / 2, side, side, 0, 0, size, size);
        ctx.restore();

        ctx.save();
        roundRect(ctx, box, bubbleRadius);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = Math.max(2, size * 0.018);
        ctx.stroke();
        ctx.restore();
    }

    for (const text of edit.texts) {
        const amount = textAmount(text, time);
        if (amount > 0 && text.text.trim()) drawText(ctx, text, width, height, amount);
    }

    ctx.restore();
    return content;
}

const TEXT_LINE_HEIGHT = 1.2;
/** Padding around text on a box background, as a fraction of the font size. */
const TEXT_BOX_PADDING = 0.45;

/** Size and position of a text in a frame of the given size (shared by drawing and the drag handle). */
export function measureText(ctx: CanvasRenderingContext2D, text: TextOverlay, width: number, height: number) {
    const fontSize = Math.max(6, text.size * height);
    ctx.font = `${text.bold ? 700 : 500} ${fontSize}px ${fontStack(text.font)}`;
    const lines = text.text.split('\n');
    const lineHeight = fontSize * TEXT_LINE_HEIGHT;
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), fontSize * 0.5);
    const pad = text.background === 'box' ? fontSize * TEXT_BOX_PADDING : 0;
    const boxWidth = textWidth + pad * 2;
    const boxHeight = lines.length * lineHeight + pad * 2;
    return {
        fontSize,
        lines,
        lineHeight,
        box: { x: text.x * width - boxWidth / 2, y: text.y * height - boxHeight / 2, width: boxWidth, height: boxHeight },
        pad,
    };
}

function drawText(ctx: CanvasRenderingContext2D, text: TextOverlay, width: number, height: number, amount: number) {
    const { fontSize, lines, lineHeight, box, pad } = measureText(ctx, text, width, height);
    ctx.save();
    ctx.globalAlpha = amount;
    // Rise slightly while fading in and out.
    ctx.translate(0, (1 - amount) * fontSize * 0.25);
    if (text.background === 'box') {
        ctx.fillStyle = 'rgba(12, 12, 16, 0.72)';
        ctx.beginPath();
        ctx.roundRect(box.x, box.y, box.width, box.height, fontSize * 0.3);
        ctx.fill();
    } else {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = fontSize * 0.25;
        ctx.shadowOffsetY = fontSize * 0.05;
    }
    ctx.fillStyle = text.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, index) => {
        ctx.fillText(line, box.x + box.width / 2, box.y + pad + lineHeight * (index + 0.5));
    });
    ctx.restore();
}

export function backgroundCss(background: Background) {
    return background.type === 'gradient' ? `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})` : background.color;
}

function fillBackground(ctx: CanvasRenderingContext2D, background: Background, width: number, height: number) {
    if (background.type === 'color') {
        ctx.fillStyle = background.color;
    } else {
        // Same direction convention as CSS linear-gradient (0deg points up, 90deg right).
        const angle = (background.angle * Math.PI) / 180;
        const dx = Math.sin(angle);
        const dy = -Math.cos(angle);
        const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
        const cx = width / 2;
        const cy = height / 2;
        const gradient = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
        gradient.addColorStop(0, background.from);
        gradient.addColorStop(1, background.to);
        ctx.fillStyle = gradient;
    }
    ctx.fillRect(0, 0, width, height);
}

function roundRect(ctx: CanvasRenderingContext2D, rect: Rect, radius: number) {
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
}

/** 0 → 1 → 0 over the moments after a click: a quick dip, then a softer release. */
function pressAmount(sinceClick: number) {
    if (sinceClick < 0 || sinceClick >= PRESS_IN + PRESS_OUT) return 0;
    const k = sinceClick < PRESS_IN ? sinceClick / PRESS_IN : 1 - (sinceClick - PRESS_IN) / PRESS_OUT;
    return k * k * (3 - 2 * k);
}

/** Draws the cursor with its hotspot at (x, y). */
function drawCursor(ctx: CanvasRenderingContext2D, shape: CursorShape, x: number, y: number, size: number) {
    if (shape === 'hand') drawHand(ctx, x, y, size);
    else if (shape === 'dot') drawDot(ctx, x, y, size);
    else drawArrow(ctx, x, y, size);
}

/** A pointing hand, drawn in a 24×24 box with the fingertip at (10.5, 2). */
function drawHand(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    const k = size / 24;
    ctx.save();
    ctx.translate(x - 10.5 * k, y - 2 * k);
    ctx.scale(k, k);
    ctx.beginPath();
    ctx.roundRect(8.5, 1, 4, 12, 2); // index finger
    ctx.roundRect(12.2, 8.5, 3.4, 6, 1.7); // middle finger
    ctx.roundRect(15.4, 9.5, 3.2, 5.5, 1.6); // ring finger
    ctx.roundRect(5.2, 11, 3.6, 5.5, 1.8); // thumb
    ctx.roundRect(6.5, 11.5, 12.5, 10, [2, 2, 4, 4]); // palm
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#fff';
    ctx.fill('nonzero');
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    ctx.stroke();
    // Fill again so the outlines between overlapping fingers disappear.
    ctx.fill('nonzero');
    ctx.beginPath();
    ctx.roundRect(8.5, 1, 4, 12, 2);
    ctx.stroke();
    ctx.restore();
}

/** A presentation-style dot, centred on the pointer. */
function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    const radius = size * 0.28;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = radius * 0.6;
    ctx.fillStyle = 'rgba(20, 20, 24, 0.8)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1.5, radius * 0.28);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    const k = size / 24;
    ctx.save();
    // The arrow's tip is at (3, 2) in its 24×24 design box.
    ctx.translate(x - 3 * k, y - 2 * k);
    ctx.scale(k, k);
    ctx.beginPath();
    ctx.moveTo(3, 2);
    ctx.lineTo(3, 19);
    ctx.lineTo(7.5, 14.8);
    ctx.lineTo(10.4, 21.5);
    ctx.lineTo(13.4, 20.2);
    ctx.lineTo(10.6, 13.6);
    ctx.lineTo(16.8, 13.6);
    ctx.closePath();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
}

/**
 * Cursor position averaged over a window centred on t. Averaging (instead of a spring) gives
 * the same result every time a frame is drawn, which export needs.
 */
export function smoothedCursor(data: CursorData, t: number, window: number) {
    if (window <= 0.001) return cursorAt(data, t);
    const samples = 9;
    let x = 0;
    let y = 0;
    let weight = 0;
    for (let i = 0; i < samples; i++) {
        const offset = (i / (samples - 1) - 0.5) * window;
        const point = cursorAt(data, t + offset);
        if (!point) return null;
        const w = 1 - Math.abs(offset) / window; // triangle weights favour the present
        x += point.x * w;
        y += point.y * w;
        weight += w;
    }
    return { x: x / weight, y: y / weight };
}

/** Linear interpolation between the recorded cursor samples. */
export function cursorAt(data: CursorData, t: number) {
    const moves = data.moves;
    if (moves.length === 0) return null;
    if (t <= moves[0][0]) return { x: moves[0][1], y: moves[0][2] };
    let low = 0;
    let high = moves.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (moves[mid][0] <= t) low = mid;
        else high = mid - 1;
    }
    const [t0, x0, y0] = moves[low];
    const next = moves[low + 1];
    if (!next) return { x: x0, y: y0 };
    const [t1, x1, y1] = next;
    const k = t1 > t0 ? Math.min(1, (t - t0) / (t1 - t0)) : 0;
    return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k };
}
