import { fileUrl, type CursorData, type Project } from '../lib/api';
import { cameraViewport, cursorVisibility, smoothCursorAt } from './motion';
import { captionAt, fontStack, hideActive, textFrame, type Caption, type CaptionStyle, type HideRegion, type TextFrame, type Background, type CursorShape, type Edit, type NormalizedRect, type TextOverlay } from './model';

/** Cursor height in screen points before scaling. */
const CURSOR_POINTS = 22;
const CLICK_DURATION = 0.45;
/** The cursor dips to this size on a click, then springs back. */
const PRESS_DEPTH = 0.22;
const PRESS_IN = 0.08;
const PRESS_OUT = 0.22;
const FULL: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
/** Motion blur looks back over this much time at full strength (half a frame at 60 fps, like a 180° shutter). */
const SHUTTER = 1 / 120;
/** Most screen copies blended for motion blur. */
const BLUR_SAMPLES = 5;

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
    /** Show the cropped screen without zooming (while placing a zoom's focus). */
    noZoom?: boolean;
    /**
     * Drawing for the live preview. Screen motion blur is left out there: it means copying the
     * full-size video frame again on every frame of a zoom, which stalls playback of big
     * (Retina) recordings. Exports always include it.
     */
    preview?: boolean;
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
 * The camera is a spring simulation over the zooms (see motion.ts), so zooms ease in and out,
 * pan smoothly while following the cursor, and glide from one zoom to the next.
 */
export function zoomViewport(edit: Edit, cursor: CursorData | null, t: number, crop: NormalizedRect): NormalizedRect {
    return cameraViewport({ zooms: edit.zooms, crop, cursor, cursorAnimation: edit.cursor.animation, screen: edit.motion.screen }, t);
}

/**
 * Which part of the recorded screen is visible at source time t (crop and zoom applied, normalized
 * to the whole recording), and where it is drawn in a frame of the given size.
 */
export function screenView(edit: Edit, project: Project, cursor: CursorData | null, time: number, width: number, height: number, ignoreCrop = false, noZoom = false) {
    const baseCrop = ignoreCrop ? FULL : edit.crop;
    // Zooming narrows the visible part of the screen further.
    const view = ignoreCrop || noZoom ? FULL : zoomViewport(edit, cursor, time, baseCrop);
    const crop = {
        x: baseCrop.x + view.x * baseCrop.width,
        y: baseCrop.y + view.y * baseCrop.height,
        width: baseCrop.width * view.width,
        height: baseCrop.height * view.height,
    };
    // Layout uses the un-zoomed crop so the frame keeps its size while zooming.
    const content = layoutFrame(edit, project, width, height, ignoreCrop);
    return { crop, content };
}

/** A box normalized to the recorded screen, in frame pixels for the given view. */
export function screenRectToFrame(rect: NormalizedRect, view: { crop: NormalizedRect; content: Rect }): Rect {
    const { crop, content } = view;
    return {
        x: content.x + ((rect.x - crop.x) / crop.width) * content.width,
        y: content.y + ((rect.y - crop.y) / crop.height) * content.height,
        width: (rect.width / crop.width) * content.width,
        height: (rect.height / crop.height) * content.height,
    };
}

export function drawFrame(ctx: CanvasRenderingContext2D, width: number, height: number, inputs: FrameInputs): Rect {
    const { edit, project, screen, camera, cursor, time } = inputs;
    const { crop, content } = screenView(edit, project, cursor, time, width, height, inputs.ignoreCrop, inputs.noZoom);
    const radius = Math.min(edit.radius * width, content.width / 2, content.height / 2);

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    fillBackground(ctx, edit.background, width, height, project);

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
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const drawScreen = (view: NormalizedRect) =>
            ctx.drawImage(screen.image, view.x * screen.width, view.y * screen.height, view.width * screen.width, view.height * screen.height, content.x, content.y, content.width, content.height);
        const trail = inputs.ignoreCrop || inputs.noZoom || inputs.preview ? [] : blurTrail(edit, project, cursor, time, width, height, crop, content);
        const blurSource = trail.length > 0 ? copyForBlur(screen, trail, content) : null;
        if (blurSource) {
            // Average the views along the camera's recent path: each copy covers its share. They
            // are drawn from one small copy of the frame: reading a big video frame several times
            // per frame is slow enough to stall playback.
            const { canvas, area, scaleX, scaleY } = blurSource;
            trail.forEach((view, i) => {
                ctx.globalAlpha = 1 / (i + 1);
                ctx.drawImage(canvas, (view.x - area.x) * scaleX, (view.y - area.y) * scaleY, view.width * scaleX, view.height * scaleY, content.x, content.y, content.width, content.height);
            });
            ctx.globalAlpha = 1;
        } else {
            drawScreen(crop);
        }
        // Hidden areas go over the screen but under the cursor (the cursor is never private).
        for (const hide of edit.hides) {
            if (hideActive(hide, time)) drawHide(ctx, hide, screen, screenRectToFrame(hide, { crop, content }), width, height);
        }
    }

    // Cursor and clicks, mapped from the recorded area into the cropped screen.
    if (cursor && edit.cursor.visible) {
        const style = edit.cursor;
        const areaPoints = project.source.area.width * crop.width;
        const scale = content.width / areaPoints;
        const toFrame = (x: number, y: number) => ({
            x: content.x + ((x - crop.x) / crop.width) * content.width,
            y: content.y + ((y - crop.y) / crop.height) * content.height,
        });
        const unit = scale * style.size;
        let lastClick = -Infinity;
        for (const [t, x, y, button] of cursor.clicks) {
            if (t <= time) lastClick = Math.max(lastClick, t);
            if (style.clickStyle === 'none' || time < t || time >= t + CLICK_DURATION) continue;
            drawClick(ctx, style.clickStyle, style.clickColor, toFrame(x, y), (time - t) / CLICK_DURATION, unit, scale, button === 'right');
        }
        const alpha = style.hideIdle ? cursorVisibility(cursor, time, style.idleDelay) : 1;
        const pointer = alpha > 0.001 ? smoothCursorAt(cursor, time, style.animation) : null;
        if (pointer) {
            const point = toFrame(pointer.x, pointer.y);
            const press = style.pressEffect ? pressAmount(time - lastClick) : 0;
            const size = CURSOR_POINTS * unit * (1 - PRESS_DEPTH * press);
            // Motion blur: fainter copies along where the cursor just was, in frame pixels.
            const blur = edit.motion.blur;
            const before = blur > 0 ? smoothCursorAt(cursor, time - (SHUTTER * 4) * blur, style.animation) : null;
            const trail = before ? toFrame(before.x, before.y) : point;
            const distance = Math.hypot(point.x - trail.x, point.y - trail.y);
            const copies = Math.min(8, Math.floor(distance / Math.max(1, size * 0.08)));
            ctx.save();
            for (let i = copies; i >= 1; i--) {
                const k = i / (copies + 1);
                ctx.globalAlpha = alpha * (1 - k) * 0.35;
                drawCursor(ctx, style.shape, point.x + (trail.x - point.x) * k, point.y + (trail.y - point.y) * k, size);
            }
            ctx.globalAlpha = alpha;
            drawCursor(ctx, style.shape, point.x, point.y, size);
            ctx.restore();
        }
    }
    ctx.restore();

    // Camera bubble.
    if (camera && inputs.cameraActive && edit.camera.visible) {
        const short = Math.min(width, height);
        // Shrink to 70% while zoomed in (fully by 1.5×), so the bubble covers less of the action.
        const zoomedIn = edit.camera.shrinkOnZoom && !inputs.ignoreCrop ? Math.min(1, Math.max(0, (edit.crop.width / crop.width - 1) / 0.5)) : 0;
        const size = edit.camera.size * short * (1 - 0.3 * zoomedIn);
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
        const frame = textFrame(text, time);
        if (frame.alpha > 0 && text.text.trim()) drawText(ctx, text, width, height, frame);
    }

    if (edit.captions.visible) {
        const caption = captionAt(edit.captions.items, time);
        if (caption && caption.text.trim()) drawCaption(ctx, caption, edit.captions.style, time, width, height);
    }

    ctx.restore();
    return content;
}

// ---- Hide regions ----

/** Two scratch canvases for shrinking a region step by step (frames are drawn one at a time). */
const scratch: HTMLCanvasElement[] = [];
const scratchCanvas = (index: number, width: number, height: number) => {
    scratch[index] ??= document.createElement('canvas');
    const canvas = scratch[index];
    if (canvas.width < width) canvas.width = width;
    if (canvas.height < height) canvas.height = height;
    return canvas;
};

/**
 * Shrinks part of the screen to `cellsX` × `cellsY` pixels, each the average of the area it
 * covers. Browsers shrink a big step by sampling a few pixels (thin text mostly disappears into
 * the background), so it's halved repeatedly instead, which averages everything.
 */
function averageDown(screen: FrameSource, area: Rect, cellsX: number, cellsY: number) {
    let source: CanvasImageSource = screen.image;
    let sx = area.x;
    let sy = area.y;
    let w = area.width;
    let h = area.height;
    let index = 0;
    while (true) {
        const nw = Math.max(cellsX, Math.ceil(w / 2));
        const nh = Math.max(cellsY, Math.ceil(h / 2));
        const canvas = scratchCanvas(index, nw, nh);
        const c = canvas.getContext('2d');
        if (!c) return null;
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.clearRect(0, 0, nw, nh);
        c.drawImage(source, sx, sy, w, h, 0, 0, nw, nh);
        source = canvas;
        sx = 0;
        sy = 0;
        w = nw;
        h = nh;
        index = 1 - index;
        if (nw === cellsX && nh === cellsY) return { canvas, width: nw, height: nh };
    }
}

/**
 * Hides a part of the screen. Pixelate and blur shrink that part of the recording to a few
 * pixels and stretch it back, so nothing readable survives; solid covers it completely.
 */
function drawHide(ctx: CanvasRenderingContext2D, hide: HideRegion, screen: FrameSource, box: Rect, width: number, height: number) {
    if (box.width < 1 || box.height < 1) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    if (hide.style === 'solid') {
        ctx.fillStyle = '#1c1c1e';
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.restore();
        return;
    }
    // Block size relative to the frame, so it looks the same in the preview and in the export.
    const block = Math.max(4, Math.min(width, height) * (hide.style === 'pixelate' ? 0.02 : 0.05));
    const cellsX = Math.max(1, Math.round(box.width / block));
    const cellsY = Math.max(1, Math.round(box.height / block));
    const area = { x: hide.x * screen.width, y: hide.y * screen.height, width: hide.width * screen.width, height: hide.height * screen.height };
    const shrunk = averageDown(screen, area, cellsX, cellsY);
    if (!shrunk) {
        ctx.restore();
        return;
    }
    const small = shrunk.canvas;
    if (hide.style === 'pixelate') {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, cellsX, cellsY, box.x, box.y, box.width, box.height);
    } else {
        // Stretching a tiny image with smoothing reads as a heavy blur; a little extra softening
        // hides the bilinear "grid" where the browser supports canvas filters.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.filter = `blur(${(block * 0.35).toFixed(1)}px)`;
        const bleed = block;
        ctx.drawImage(small, 0, 0, cellsX, cellsY, box.x - bleed / 2, box.y - bleed / 2, box.width + bleed, box.height + bleed);
        ctx.filter = 'none';
    }
    ctx.restore();
}

// ---- Captions ----

const CAPTION_LINE_HEIGHT = 1.25;
/** Captions wrap at this share of the frame width. */
const CAPTION_MAX_WIDTH = 0.82;

/** Lays a caption out in lines of words that fit the frame (shared by drawing and measuring). */
export function layoutCaption(ctx: CanvasRenderingContext2D, caption: Caption, style: CaptionStyle, width: number, height: number) {
    const fontSize = Math.max(8, style.size * Math.min(width, height));
    ctx.font = `${style.bold ? 700 : 500} ${fontSize}px ${fontStack(style.font)}`;
    const words = caption.words.length > 0 ? caption.words : caption.text.split(/\s+/).filter(Boolean).map((text) => ({ start: caption.start, end: caption.end, text }));
    const space = ctx.measureText(' ').width;
    const maxWidth = width * CAPTION_MAX_WIDTH;
    const lines: { words: { text: string; start: number; end: number; x: number; width: number }[]; width: number }[] = [];
    let line: (typeof lines)[number] = { words: [], width: 0 };
    for (const word of words) {
        const w = ctx.measureText(word.text).width;
        const next = line.width + (line.words.length ? space : 0) + w;
        if (line.words.length && next > maxWidth) {
            lines.push(line);
            line = { words: [], width: 0 };
        }
        const x = line.width + (line.words.length ? space : 0);
        line.words.push({ ...word, x, width: w });
        line.width = x + w;
    }
    if (line.words.length) lines.push(line);
    const lineHeight = fontSize * CAPTION_LINE_HEIGHT;
    const blockHeight = lines.length * lineHeight;
    const margin = Math.min(width, height) * 0.06;
    const top = style.position === 'top' ? margin : height - margin - blockHeight;
    return { fontSize, lines, lineHeight, top };
}

function drawCaption(ctx: CanvasRenderingContext2D, caption: Caption, style: CaptionStyle, time: number, width: number, height: number) {
    const { fontSize, lines, lineHeight, top } = layoutCaption(ctx, caption, style, width, height);
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const padX = fontSize * 0.4;
    const padY = fontSize * 0.12;
    lines.forEach((line, i) => {
        const left = (width - line.width) / 2;
        const centreY = top + i * lineHeight + lineHeight / 2;
        if (style.background === 'box') {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
            const box = { x: left - padX, y: centreY - lineHeight / 2 - padY, width: line.width + padX * 2, height: lineHeight + padY * 2 };
            roundRect(ctx, box, fontSize * 0.25);
            ctx.fill();
        }
        if (style.background === 'shadow') {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
            ctx.shadowBlur = fontSize * 0.25;
            ctx.shadowOffsetY = fontSize * 0.05;
        }
        for (const word of line.words) {
            const speaking = style.highlight && time >= word.start && time < word.end;
            ctx.fillStyle = speaking ? style.highlight! : style.color;
            ctx.fillText(word.text, left + word.x, centreY);
        }
        ctx.shadowColor = 'transparent';
    });
    ctx.restore();
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

function drawText(ctx: CanvasRenderingContext2D, text: TextOverlay, width: number, height: number, frame: TextFrame) {
    const { fontSize, lines, lineHeight, box, pad } = measureText(ctx, text, width, height);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.save();
    ctx.globalAlpha = frame.alpha;
    ctx.translate(frame.dx * fontSize, frame.dy * fontSize);
    if (frame.scale !== 1) {
        ctx.translate(cx, cy);
        ctx.scale(frame.scale, frame.scale);
        ctx.translate(-cx, -cy);
    }
    if (frame.blur > 0.001) ctx.filter = `blur(${(frame.blur * fontSize).toFixed(2)}px)`;
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
    ctx.textBaseline = 'middle';
    const lineY = (index: number) => box.y + pad + lineHeight * (index + 0.5);

    if (text.animation === 'typewriter' || text.animation === 'words') {
        // Lay out the full text first and reveal parts of it in place, so nothing reflows.
        ctx.textAlign = 'left';
        const units = text.animation === 'words' ? text.text.split(/\s+/).filter(Boolean).length : text.text.replace(/\n/g, '').length;
        const shown = frame.reveal * units;
        let seen = 0;
        let caretAt: { x: number; y: number } | null = null;
        lines.forEach((line, index) => {
            const left = cx - ctx.measureText(line).width / 2;
            const y = lineY(index);
            if (text.animation === 'typewriter') {
                const count = Math.max(0, Math.min(line.length, Math.floor(shown - seen)));
                ctx.fillText(line.slice(0, count), left, y);
                if (count < line.length && !caretAt && frame.caret) caretAt = { x: left + ctx.measureText(line.slice(0, count)).width, y };
                seen += line.length;
            } else {
                // Each word fades and rises in over its own slot.
                let offset = 0;
                for (const part of line.split(/(\s+)/)) {
                    if (part.trim()) {
                        const k = Math.max(0, Math.min(1, shown - seen));
                        seen += 1;
                        if (k > 0) {
                            ctx.save();
                            ctx.globalAlpha = frame.alpha * k;
                            ctx.fillText(part, left + offset, y + (1 - k) * fontSize * 0.3);
                            ctx.restore();
                        }
                    }
                    offset += ctx.measureText(part).width;
                }
            }
        });
        if (caretAt) {
            const { x, y } = caretAt;
            ctx.fillRect(x + fontSize * 0.04, y - fontSize * 0.45, Math.max(1, fontSize * 0.07), fontSize * 0.9);
        }
    } else {
        ctx.textAlign = 'center';
        lines.forEach((line, index) => ctx.fillText(line, cx, lineY(index)));
    }
    ctx.restore();
}

export function backgroundCss(background: Background, project?: Project) {
    if (background.type === 'image') return project ? `center / cover no-repeat url("${fileUrl(project, background.file)}")` : '#444';
    return background.type === 'gradient' ? `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})` : background.color;
}

/** Loaded background images by URL. Drawing can't wait, so the preview fills grey until it loads. */
const images = new Map<string, HTMLImageElement>();

function loadImage(url: string) {
    let image = images.get(url);
    if (!image) {
        image = new Image();
        image.decoding = 'async';
        image.src = url;
        images.set(url, image);
    }
    return image;
}

/** Waits for the background image (if any), so every exported frame has it. */
export async function preloadBackground(project: Project, background: Background) {
    if (background.type !== 'image') return;
    const image = loadImage(fileUrl(project, background.file));
    if (!image.complete) await image.decode().catch(() => {});
}

function fillBackground(ctx: CanvasRenderingContext2D, background: Background, width: number, height: number, project: Project) {
    if (background.type === 'image') {
        const image = loadImage(fileUrl(project, background.file));
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(0, 0, width, height);
        if (!image.complete || image.naturalWidth === 0) return;
        // Cover the frame; blur bleeds in transparent edges, so draw a little larger when blurred.
        const blur = background.blur * Math.min(width, height) * 0.04;
        const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * (blur > 0 ? 1.08 : 1);
        const w = image.naturalWidth * scale;
        const h = image.naturalHeight * scale;
        ctx.save();
        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;
        ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
        ctx.restore();
        return;
    }
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
 * Views of the screen along the camera's path over the last moment, newest first, when it moved
 * enough to need motion blur; otherwise empty. The spread is measured in frame pixels so the
 * blur looks the same in the preview and at any export size.
 */
function blurTrail(edit: Edit, project: Project, cursor: CursorData | null, time: number, width: number, height: number, crop: NormalizedRect, content: Rect): NormalizedRect[] {
    const strength = edit.motion.blur;
    if (strength <= 0 || edit.zooms.length === 0) return [];
    const span = SHUTTER * 4 * strength;
    const previous = screenView(edit, project, cursor, time - span, width, height).crop;
    // How far the edges of the view moved on screen.
    const px = (dx: number) => (Math.abs(dx) / crop.width) * content.width;
    const py = (dy: number) => (Math.abs(dy) / crop.height) * content.height;
    const shift = Math.max(px(previous.x - crop.x), px(previous.x + previous.width - crop.x - crop.width), py(previous.y - crop.y), py(previous.y + previous.height - crop.y - crop.height));
    if (shift < 1.5) return [];
    const count = Math.min(BLUR_SAMPLES, 1 + Math.ceil(shift / 3));
    const views: NormalizedRect[] = [crop];
    for (let i = 1; i < count; i++) views.push(screenView(edit, project, cursor, time - (span * i) / (count - 1), width, height).crop);
    return views;
}

let blurCanvas: HTMLCanvasElement | null = null;

/**
 * Copies the part of the screen frame that the blur views cover, once, at about the size it's
 * drawn, so the views can be drawn from it cheaply. Coordinates are normalized to the recording.
 */
function copyForBlur(screen: FrameSource, views: NormalizedRect[], content: Rect) {
    const left = Math.min(...views.map((v) => v.x));
    const top = Math.min(...views.map((v) => v.y));
    const right = Math.max(...views.map((v) => v.x + v.width));
    const bottom = Math.max(...views.map((v) => v.y + v.height));
    const area = { x: left, y: top, width: right - left, height: bottom - top };
    // Pixels per normalized unit, matching the newest view's on-screen size (and never more than the source).
    const scaleX = Math.min(screen.width, content.width / views[0].width);
    const scaleY = Math.min(screen.height, content.height / views[0].height);
    const w = Math.max(1, Math.ceil(area.width * scaleX));
    const h = Math.max(1, Math.ceil(area.height * scaleY));
    blurCanvas ??= document.createElement('canvas');
    if (blurCanvas.width < w) blurCanvas.width = w;
    if (blurCanvas.height < h) blurCanvas.height = h;
    const c = blurCanvas.getContext('2d');
    if (!c) return null;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(screen.image, area.x * screen.width, area.y * screen.height, area.width * screen.width, area.height * screen.height, 0, 0, w, h);
    return { canvas: blurCanvas, area, scaleX: w / area.width, scaleY: h / area.height };
}

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

/** A click at `point`, `progress` 0 → 1 through its animation. Right-clicks get a double ring. */
function drawClick(ctx: CanvasRenderingContext2D, style: 'ripple' | 'pulse', color: string, point: { x: number; y: number }, progress: number, unit: number, scale: number, right: boolean) {
    const grow = easeOutCubic(progress);
    const fade = 1 - progress * progress;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (style === 'ripple') {
        const radius = (6 + grow * 20) * unit;
        ctx.lineWidth = Math.max(1.5, 2.5 * scale * (1 - progress * 0.5));
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        // A soft fill under the ring, strongest at the moment of the click.
        ctx.globalAlpha = 0.18 * (1 - grow);
        ctx.fill();
        if (right) {
            ctx.globalAlpha = fade * 0.7;
            ctx.beginPath();
            ctx.arc(point.x, point.y, radius * 0.6, 0, Math.PI * 2);
            ctx.stroke();
        }
    } else {
        ctx.globalAlpha = 0.45 * fade;
        ctx.beginPath();
        ctx.arc(point.x, point.y, (7 + grow * 9) * unit, 0, Math.PI * 2);
        ctx.fill();
        if (right) {
            ctx.globalAlpha = 0.6 * fade;
            ctx.lineWidth = Math.max(1, 1.5 * scale);
            ctx.stroke();
        }
    }
    ctx.restore();
}
