import type { CursorData } from '../lib/api';
import type { NormalizedRect, Zoom } from './model';

/**
 * Spring-driven motion for the cursor and the zoom camera.
 *
 * Springs feel natural because they carry velocity: the camera never starts or stops with a jolt,
 * and a new target mid-move bends the path instead of restarting it. A spring has state, though,
 * and every frame must look the same whether it's drawn while scrubbing the preview or during
 * export. So each path is simulated once over the whole recording at a fixed step, cached, and
 * looked up by time.
 */

/** Simulation step in seconds (twice the usual frame rate, so 60 fps exports interpolate finely). */
const STEP = 1 / 120;

export interface SpringConfig {
    tension: number;
    friction: number;
    mass: number;
}

export type CursorAnimation = 'mellow' | 'smooth' | 'quick' | 'off';
export type ScreenAnimation = 'smooth' | 'focused';

export const CURSOR_ANIMATIONS: { value: CursorAnimation; label: string; hint: string }[] = [
    { value: 'mellow', label: 'Mellow', hint: 'Gently smoothed, still follows quick moves closely' },
    { value: 'smooth', label: 'Smooth', hint: 'Slow, floaty glide; best for calm walkthroughs' },
    { value: 'quick', label: 'Quick', hint: 'Snappy; removes shakes but keeps the pace' },
    { value: 'off', label: 'Off', hint: 'The cursor exactly as it was recorded' },
];

export const SCREEN_ANIMATIONS: { value: ScreenAnimation; label: string; hint: string }[] = [
    { value: 'smooth', label: 'Smooth', hint: 'Fluid, cinematic zooms and pans' },
    { value: 'focused', label: 'Focused', hint: 'Settles quickly, so the screen is readable sooner' },
];

const CURSOR_SPRINGS: Record<Exclude<CursorAnimation, 'off'>, SpringConfig> = {
    mellow: { tension: 470, friction: 70, mass: 3 },
    smooth: { tension: 80, friction: 28, mass: 2.5 },
    quick: { tension: 380, friction: 30, mass: 1 },
};
/** Stiffer spring just before a click, so the cursor lands exactly on what was clicked. */
const CLICK_SPRING: SpringConfig = { tension: 530, friction: 40, mass: 1 };
const CLICK_WINDOW = 0.175;

const SCREEN_SPRINGS: Record<ScreenAnimation, SpringConfig> = {
    smooth: { tension: 200, friction: 40, mass: 2.25 },
    focused: { tension: 300, friction: 45, mass: 1.5 },
};

// ---- Spring maths ----

/**
 * Exact solution of a damped spring over one fixed step, as a matrix on (displacement, velocity).
 * With a constant step the response is linear, so it's computed once per spring and each step of
 * the simulation is four multiplications, with no integration error.
 */
function springMatrix(cfg: SpringConfig, dt: number) {
    const { tension: k, friction: c, mass: m } = cfg;
    const w0 = Math.sqrt(k / m);
    const zeta = c / (2 * Math.sqrt(k * m));
    const solve = (d: number, v: number): [number, number] => {
        if (Math.abs(zeta - 1) < 1e-3) {
            const e = Math.exp(-w0 * dt);
            const b = v + w0 * d;
            return [(d + b * dt) * e, (v - w0 * b * dt) * e];
        }
        if (zeta < 1) {
            const wd = w0 * Math.sqrt(1 - zeta * zeta);
            const a = zeta * w0;
            const e = Math.exp(-a * dt);
            const B = (v + a * d) / wd;
            const cos = Math.cos(wd * dt);
            const sin = Math.sin(wd * dt);
            return [e * (d * cos + B * sin), e * ((B * wd - a * d) * cos - (d * wd + a * B) * sin)];
        }
        const s = Math.sqrt(zeta * zeta - 1);
        const r1 = -w0 * (zeta - s);
        const r2 = -w0 * (zeta + s);
        const c2 = (v - r1 * d) / (r2 - r1);
        const c1 = d - c2;
        const e1 = Math.exp(r1 * dt);
        const e2 = Math.exp(r2 * dt);
        return [c1 * e1 + c2 * e2, r1 * c1 * e1 + r2 * c2 * e2];
    };
    const [dd, vd] = solve(1, 0);
    const [dv, vv] = solve(0, 1);
    return { dd, dv, vd, vv };
}

type Matrix = ReturnType<typeof springMatrix>;

/** One spring axis: position and velocity, pulled towards a target. */
class Axis {
    x: number;
    v = 0;
    constructor(x: number) {
        this.x = x;
    }
    step(target: number, m: Matrix) {
        const d = this.x - target;
        this.x = target + m.dd * d + m.dv * this.v;
        this.v = m.vd * d + m.vv * this.v;
    }
    snap(value: number) {
        this.x = value;
        this.v = 0;
    }
}

/** How far behind a moving target a spring trails, in seconds (friction / tension for a steady pull). */
const springLag = (cfg: SpringConfig) => cfg.friction / cfg.tension;

const smoothstep = (x: number) => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
};

// ---- Raw cursor ----

/**
 * The recorder only writes a sample when the cursor moves, so a pause shows up as one long gap.
 * Interpolating straight across it would make the cursor creep for seconds before the real move;
 * holding still until just before the next sample matches what actually happened.
 */
function withHolds(moves: CursorData['moves']) {
    const out: CursorData['moves'] = [];
    const frame = 1 / 60;
    for (let i = 0; i < moves.length; i++) {
        const previous = out[out.length - 1];
        const t = moves[i][0];
        if (previous && t - previous[0] > frame * 2) out.push([t - frame, previous[1], previous[2]]);
        out.push(moves[i]);
    }
    return out;
}

/** A wobble smaller than this (share of the recorded area, about 7 pt on a laptop screen)… */
const SHAKE_SIZE = 0.004;
/** …that goes out and comes back within this many seconds is hand shake, not movement. */
const SHAKE_TIME = 0.1;

/**
 * Removes hand shake: a sample that jumps a tiny bit one way and straight back (A → B → C, with
 * B close to both and C reversing the step) is dropped, so smoothing doesn't turn the jitter
 * into a slow wobble. Deliberate moves are larger or keep their direction, and stay.
 */
function withoutShake(moves: CursorData['moves']) {
    const out: CursorData['moves'] = [];
    for (let i = 0; i < moves.length; i++) {
        const a = out[out.length - 1];
        const b = moves[i];
        const c = moves[i + 1];
        if (a && c && c[0] - a[0] < SHAKE_TIME) {
            const abx = b[1] - a[1];
            const aby = b[2] - a[2];
            const bcx = c[1] - b[1];
            const bcy = c[2] - b[2];
            const small = Math.hypot(abx, aby) < SHAKE_SIZE && Math.hypot(bcx, bcy) < SHAKE_SIZE;
            if (small && abx * bcx + aby * bcy < 0) continue;
        }
        out.push(b);
    }
    return out;
}

const holdsCache = new WeakMap<CursorData, CursorData['moves']>();
const steadyCache = new WeakMap<CursorData, CursorData['moves']>();
const cleanMoves = (data: CursorData) => {
    let moves = holdsCache.get(data);
    if (!moves) {
        moves = withHolds(data.moves);
        holdsCache.set(data, moves);
    }
    return moves;
};
/** The moves with pauses held and hand shake removed (what smoothed cursors follow). */
const steadyMoves = (data: CursorData) => {
    let moves = steadyCache.get(data);
    if (!moves) {
        moves = withHolds(withoutShake(data.moves));
        steadyCache.set(data, moves);
    }
    return moves;
};

/** Index of the last sample at or before t (0 if t is before the first). */
function sampleIndex(moves: CursorData['moves'], t: number) {
    let low = 0;
    let high = moves.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (moves[mid][0] <= t) low = mid;
        else high = mid - 1;
    }
    return low;
}

/**
 * The recorded cursor at source time t (linear between samples, still during pauses). `steady`
 * leaves out hand shake, for the smoothed cursor.
 */
export function cursorAt(data: CursorData, t: number, steady = false) {
    const moves = steady ? steadyMoves(data) : cleanMoves(data);
    if (moves.length === 0) return null;
    if (t <= moves[0][0]) return { x: moves[0][1], y: moves[0][2] };
    const low = sampleIndex(moves, t);
    const [t0, x0, y0] = moves[low];
    const next = moves[low + 1];
    if (!next) return { x: x0, y: y0 };
    const [t1, x1, y1] = next;
    const k = t1 > t0 ? Math.min(1, (t - t0) / (t1 - t0)) : 0;
    return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k };
}

// ---- Smoothed cursor ----

interface Path {
    /** Interleaved samples, `stride` numbers per step of STEP seconds from time 0. */
    data: Float32Array;
    stride: number;
    steps: number;
}

function samplePath(path: Path, t: number, out: number[]) {
    const f = Math.max(0, t / STEP);
    const i = Math.min(path.steps - 1, Math.floor(f));
    const j = Math.min(path.steps - 1, i + 1);
    const k = Math.min(1, f - i);
    for (let n = 0; n < path.stride; n++) {
        const a = path.data[i * path.stride + n];
        out[n] = a + (path.data[j * path.stride + n] - a) * k;
    }
    return out;
}

function buildCursorPath(data: CursorData, animation: Exclude<CursorAnimation, 'off'>): Path | null {
    const moves = cleanMoves(data);
    if (moves.length === 0) return null;
    const cfg = CURSOR_SPRINGS[animation];
    const main = springMatrix(cfg, STEP);
    const click = springMatrix(CLICK_SPRING, STEP);
    // Aim ahead by the spring's lag, so smoothing removes shakes without the cursor trailing behind.
    const lead = springLag(cfg);
    const clicks = data.clicks.map(([t, x, y]) => ({ t, x, y })).sort((a, b) => a.t - b.t);
    const end = Math.max(moves[moves.length - 1][0], clicks.length ? clicks[clicks.length - 1].t : 0) + 1;
    const steps = Math.ceil(end / STEP) + 2;
    const out = new Float32Array(steps * 2);
    const start = cursorAt(data, 0)!;
    const x = new Axis(start.x);
    const y = new Axis(start.y);
    let nextClick = 0;
    for (let i = 0; i < steps; i++) {
        const t = i * STEP;
        while (nextClick < clicks.length && clicks[nextClick].t < t) nextClick++;
        const upcoming = clicks[nextClick];
        if (upcoming && upcoming.t - t <= CLICK_WINDOW) {
            x.step(upcoming.x, click);
            y.step(upcoming.y, click);
        } else {
            const target = cursorAt(data, t + lead, true)!;
            x.step(target.x, main);
            y.step(target.y, main);
        }
        out[i * 2] = x.x;
        out[i * 2 + 1] = y.x;
    }
    // Pin the cursor to the exact click point around each click, so the tip sits on the button.
    for (const c of clicks) {
        const from = Math.max(0, Math.floor((c.t - 0.1) / STEP));
        const to = Math.min(steps - 1, Math.ceil((c.t + 0.15) / STEP));
        for (let i = from; i <= to; i++) {
            const t = i * STEP;
            const w = t <= c.t ? smoothstep((t - (c.t - 0.1)) / 0.1) : 1 - smoothstep((t - c.t - 0.05) / 0.1);
            out[i * 2] += (c.x - out[i * 2]) * w;
            out[i * 2 + 1] += (c.y - out[i * 2 + 1]) * w;
        }
    }
    return { data: out, stride: 2, steps };
}

const cursorPaths = new WeakMap<CursorData, Map<CursorAnimation, Path | null>>();
const scratch = [0, 0, 0];

/** The cursor as it should be drawn at source time t, smoothed by the chosen animation. */
export function smoothCursorAt(data: CursorData, t: number, animation: CursorAnimation) {
    if (animation === 'off') return cursorAt(data, t);
    let byStyle = cursorPaths.get(data);
    if (!byStyle) {
        byStyle = new Map();
        cursorPaths.set(data, byStyle);
    }
    let path = byStyle.get(animation);
    if (path === undefined) {
        path = buildCursorPath(data, animation);
        byStyle.set(animation, path);
    }
    if (!path) return null;
    const [x, y] = samplePath(path, t, scratch);
    return { x, y };
}

/**
 * 0 (hidden) to 1 (shown): the cursor fades out after `delay` seconds without moving or
 * clicking, and fades back in just before it moves again.
 */
export function cursorVisibility(data: CursorData, t: number, delay: number) {
    const FADE = 0.3;
    const moves = data.moves;
    if (moves.length === 0) return 1;
    // Activity: real movement and clicks.
    let last = moves[sampleIndex(moves, t)][0];
    if (t < moves[0][0]) last = -Infinity;
    let next = Infinity;
    const after = sampleIndex(moves, t) + 1;
    if (t < moves[0][0]) next = moves[0][0];
    else if (after < moves.length) next = moves[after][0];
    for (const [ct] of data.clicks) {
        if (ct <= t && ct > last) last = ct;
        if (ct > t && ct < next) next = ct;
    }
    const idle = t - last;
    const out = 1 - smoothstep((idle - delay) / FADE);
    const back = 1 - smoothstep((next - t) / FADE);
    return Math.max(out, idle > delay ? back : 0);
}

// ---- Camera ----

/** While zoomed and following, the camera re-aims only when the cursor leaves this middle share of the view. */
const DEAD_ZONE = 0.6;
/** The camera aims at where the cursor is about to be, like a camera operator would. */
const FOLLOW_LOOKAHEAD = 0.2;
/** When zooming in, aim at where the cursor will be this far into the zoom (auto-zooms start just before a click). */
const ENTRY_AIM = 0.5;
/** Zooms closer together than this pan from one to the next instead of zooming out in between. */
const BRIDGE_GAP = 0.5;
/** After the last zoom the camera is at rest well within this time. */
const SETTLE = 2;

export interface CameraInputs {
    zooms: Zoom[];
    crop: NormalizedRect;
    cursor: CursorData | null;
    cursorAnimation: CursorAnimation;
    screen: ScreenAnimation;
}

/** The zoom that sets the camera's target at time t (the latest-started one when they overlap). */
function activeZoom(zooms: Zoom[], t: number) {
    let best: Zoom | null = null;
    let before: Zoom | null = null;
    let after: Zoom | null = null;
    for (const zoom of zooms) {
        if (t >= zoom.start && t < zoom.end) {
            if (!best || zoom.start > best.start) best = zoom;
        } else if (zoom.end <= t) {
            if (!before || zoom.end > before.end) before = zoom;
        } else if (!after || zoom.start < after.start) {
            after = zoom;
        }
    }
    if (best) return best;
    if (before && after && after.start - before.end < BRIDGE_GAP) return before;
    return null;
}

/**
 * Anchor (0..1 on each axis) that puts point p in the middle of a view of the given size.
 * The view's top-left is anchor·(1 − size), so the view never leaves the screen; near an edge the
 * anchor simply stops at 0 or 1 and the camera eases into the edge instead of hitting a wall.
 */
const anchorFor = (p: number, size: number) => (size >= 0.999 ? 0.5 : Math.min(1, Math.max(0, (p - size / 2) / (1 - size))));

function buildCameraPath(inputs: CameraInputs): Path | null {
    const { zooms, crop, cursor } = inputs;
    if (zooms.length === 0) return null;
    const end = Math.max(...zooms.map((z) => z.end)) + SETTLE;
    const steps = Math.ceil(end / STEP) + 2;
    const out = new Float32Array(steps * 3);
    const m = springMatrix(SCREEN_SPRINGS[inputs.screen], STEP);
    const pointAt = (t: number) => {
        const p = cursor ? smoothCursorAt(cursor, t, inputs.cursorAnimation) : null;
        return p ? { x: (p.x - crop.x) / crop.width, y: (p.y - crop.y) / crop.height } : null;
    };
    // Camera state: log of the zoom scale (log space makes zooming feel even) and the anchor.
    const logScale = new Axis(0);
    const ax = new Axis(0.5);
    const ay = new Axis(0.5);
    let targetLog = 0;
    let targetX = 0.5;
    let targetY = 0.5;
    let current: Zoom | null = null;
    for (let i = 0; i < steps; i++) {
        const t = i * STEP;
        const zoom = activeZoom(zooms, t);
        if (zoom !== current) {
            const instant = (zoom?.instant ?? false) || (current?.instant ?? false);
            if (zoom) {
                targetLog = Math.log(zoom.scale);
                const size = 1 / zoom.scale;
                const point = zoom.mode === 'fixed' ? { x: zoom.x, y: zoom.y } : (pointAt(current ? t + FOLLOW_LOOKAHEAD : Math.min(zoom.end, zoom.start + ENTRY_AIM)) ?? { x: zoom.x, y: zoom.y });
                targetX = anchorFor(point.x, size);
                targetY = anchorFor(point.y, size);
                // Zooming in from the full view: aim first, since moving the anchor at 1× isn't visible.
                if (logScale.x < 0.01) {
                    ax.snap(targetX);
                    ay.snap(targetY);
                }
            } else {
                targetLog = 0;
            }
            if (instant) {
                logScale.snap(targetLog);
                ax.snap(targetX);
                ay.snap(targetY);
            }
            current = zoom;
        } else if (zoom && zoom.mode === 'follow') {
            const point = pointAt(t + FOLLOW_LOOKAHEAD);
            if (point) {
                const size = 1 / zoom.scale;
                const margin = (size * (1 - DEAD_ZONE)) / 2;
                const left = targetX * (1 - size);
                const top = targetY * (1 - size);
                if (point.x < left + margin || point.x > left + size - margin) targetX = anchorFor(point.x, size);
                if (point.y < top + margin || point.y > top + size - margin) targetY = anchorFor(point.y, size);
            }
        }
        logScale.step(targetLog, m);
        ax.step(targetX, m);
        ay.step(targetY, m);
        out[i * 3] = logScale.x;
        out[i * 3 + 1] = ax.x;
        out[i * 3 + 2] = ay.x;
    }
    return { data: out, stride: 3, steps };
}

const FULL: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

interface CameraCacheEntry {
    inputs: CameraInputs;
    path: Path | null;
}
const cameraCache = new WeakMap<Zoom[], CameraCacheEntry>();

function cameraPath(inputs: CameraInputs) {
    const cached = cameraCache.get(inputs.zooms);
    const same =
        cached &&
        cached.inputs.cursor === inputs.cursor &&
        cached.inputs.screen === inputs.screen &&
        cached.inputs.cursorAnimation === inputs.cursorAnimation &&
        cached.inputs.crop.x === inputs.crop.x &&
        cached.inputs.crop.y === inputs.crop.y &&
        cached.inputs.crop.width === inputs.crop.width &&
        cached.inputs.crop.height === inputs.crop.height;
    if (same) return cached.path;
    const path = buildCameraPath(inputs);
    cameraCache.set(inputs.zooms, { inputs, path });
    return path;
}

/** The part of the (cropped) screen in view at source time t, normalized to the cropped screen. */
export function cameraViewport(inputs: CameraInputs, t: number): NormalizedRect {
    const path = cameraPath(inputs);
    if (!path || t >= path.steps * STEP) return FULL;
    const [logScale, ax, ay] = samplePath(path, t, scratch);
    if (logScale < 1e-4) return FULL;
    const size = Math.exp(-logScale);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp(ax) * (1 - size), y: clamp(ay) * (1 - size), width: size, height: size };
}
