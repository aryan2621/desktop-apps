// AI editing: turns a request ("cut the part about pricing") into a list of edits to review.
// The model reads the transcript as numbered lines and picks lines by number (easier for a small
// model than reasoning in seconds); this file turns its answer into exact times and edits.
import { invoke } from '@tauri-apps/api/core';
import type { CursorData, Project } from '../lib/api';
import { cutSource, newId, speedSource, ZOOM_HOLD, ZOOM_LEAD_IN, type Caption, type CaptionWord, type Edit, type TextOverlay, type Zoom } from './model';

/** One proposed edit, shown with a checkbox before it's applied. Times are source times. */
export interface Proposal {
    id: string;
    type: 'cut' | 'speed' | 'zoom' | 'text';
    start: number;
    end: number;
    speed?: number;
    text?: string;
    reason: string;
}

export interface AiResult {
    summary: string;
    proposals: Proposal[];
}

/** A silence longer than this becomes its own "(no speech)" line, so it can be cut or sped up. */
const SILENCE_LINE = 2.5;

const SYSTEM = `You edit screen recordings. You get the recording's transcript as numbered lines (#n [start-end] text, times in seconds; "(no speech)" lines are silent stretches), the times the user clicked, and a request.
First write a short plan: which lines the request is about (read every line; related lines next to each other usually belong together).
Then list the edits, using only these actions:
- cut: remove the given lines from the video.
- speed: play the given lines faster ("speed" from 1.5 to 4).
- zoom: zoom in on what the user does between start and end (seconds; use click times).
- text: show "text" (a title or note of at most 8 words) over the given lines.
Rules: do only what the request asks, nothing extra. Never remove every line. For cut, speed and text list the line numbers in "lines"; for zoom leave "lines" empty and give start and end. Unused fields: "lines" [], "speed" 1, "text" "", "start" 0, "end" 0. If the request can't be done with these actions, list no edits and say why in the summary. The summary is one short sentence.`;

const SCHEMA = {
    type: 'object',
    properties: {
        plan: { type: 'string' },
        actions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['cut', 'speed', 'zoom', 'text'] },
                    lines: { type: 'array', items: { type: 'integer' } },
                    start: { type: 'number' },
                    end: { type: 'number' },
                    speed: { type: 'number' },
                    text: { type: 'string' },
                    reason: { type: 'string' },
                },
                required: ['type', 'lines', 'start', 'end', 'speed', 'text', 'reason'],
            },
        },
        summary: { type: 'string' },
    },
    required: ['plan', 'actions', 'summary'],
};

interface RawAction {
    type: Proposal['type'];
    lines: number[];
    start: number;
    end: number;
    speed: number;
    text: string;
    reason: string;
}

/** The transcript as numbered lines, with long silences as lines of their own. */
export function transcriptLines(captions: Caption[], duration: number) {
    const lines: { start: number; end: number; text: string }[] = [];
    let last = 0;
    for (const caption of [...captions].sort((a, b) => a.start - b.start)) {
        if (caption.start - last >= SILENCE_LINE) lines.push({ start: last, end: caption.start, text: `(no speech, ${Math.round(caption.start - last)} s)` });
        lines.push({ start: caption.start, end: caption.end, text: caption.text });
        last = caption.end;
    }
    if (duration - last >= SILENCE_LINE) lines.push({ start: last, end: duration, text: `(no speech, ${Math.round(duration - last)} s)` });
    return lines;
}

/** Asks the model for edits that fulfil `request`. */
export async function askAi(request: string, edit: Edit, project: Project, cursor: CursorData | null): Promise<AiResult> {
    const lines = transcriptLines(edit.captions.items, project.duration);
    const transcript = lines.map((l, i) => `#${i + 1} [${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`).join('\n');
    const clicks = (cursor?.clicks ?? []).map(([t]) => t.toFixed(1)).join(', ') || 'none';
    const user = `Recording length: ${project.duration.toFixed(1)} s.\nTranscript:\n${transcript}\nClicks at (s): ${clicks}\n\nRequest: ${request}`;
    const answer = await invoke<{ summary: string; actions: RawAction[] }>('ai_edit', { request: { system: SYSTEM, user, schema: SCHEMA } });
    return { summary: answer.summary, proposals: toProposals(answer.actions, lines, project.duration) };
}

/** Turns line numbers into times: one proposal per run of consecutive lines. */
export function toProposals(actions: RawAction[], lines: { start: number; end: number }[], duration: number): Proposal[] {
    const out: Proposal[] = [];
    for (const action of actions) {
        const reason = action.reason.trim();
        if (action.type === 'zoom') {
            let start = Math.max(0, Math.min(action.start, action.end));
            let end = Math.min(duration, Math.max(action.start, action.end));
            if (end - start < 1) {
                start = Math.max(0, start - ZOOM_LEAD_IN);
                end = Math.min(duration, end + ZOOM_HOLD);
            }
            if (end > start) out.push({ id: newId(), type: 'zoom', start, end, reason });
            continue;
        }
        const valid = [...new Set(action.lines)].filter((n) => n >= 1 && n <= lines.length).sort((a, b) => a - b);
        // Consecutive lines become one range.
        const runs: [number, number][] = [];
        for (const n of valid) {
            const run = runs[runs.length - 1];
            if (run && n === run[1] + 1) run[1] = n;
            else runs.push([n, n]);
        }
        for (const [first, last] of runs) {
            const start = lines[first - 1].start;
            const end = lines[last - 1].end;
            if (end - start < 0.2) continue;
            if (action.type === 'speed') out.push({ id: newId(), type: 'speed', start, end, speed: Math.min(4, Math.max(1.25, action.speed || 2)), reason });
            else if (action.type === 'text') {
                if (action.text.trim()) out.push({ id: newId(), type: 'text', start, end: Math.max(end, start + 2), text: action.text.trim(), reason });
            } else out.push({ id: newId(), type: 'cut', start, end, reason });
        }
    }
    // Merge overlapping zooms so the camera doesn't zoom out for a split second.
    const zooms = out.filter((p) => p.type === 'zoom').sort((a, b) => a.start - b.start);
    const merged: Proposal[] = [];
    for (const zoom of zooms) {
        const previous = merged[merged.length - 1];
        if (previous && zoom.start <= previous.end + 0.5) previous.end = Math.max(previous.end, zoom.end);
        else merged.push(zoom);
    }
    return [...out.filter((p) => p.type !== 'zoom'), ...merged].sort((a, b) => a.start - b.start);
}

/** Applies the chosen proposals to the edit. */
export function applyProposals(edit: Edit, proposals: Proposal[]): Edit {
    let clips = edit.clips;
    const zooms: Zoom[] = [...edit.zooms];
    const texts: TextOverlay[] = [...edit.texts];
    for (const p of proposals) {
        if (p.type === 'cut') clips = cutSource(clips, p.start, p.end);
        else if (p.type === 'speed') clips = speedSource(clips, p.start, p.end, p.speed ?? 2);
        else if (p.type === 'zoom') zooms.push({ id: newId(), start: p.start, end: p.end, scale: edit.zoomScale, mode: 'follow', x: 0.5, y: 0.5, auto: false });
        else if (p.type === 'text')
            texts.push({ id: newId(), start: p.start, end: p.end, text: p.text ?? '', x: 0.5, y: 0.18, size: 0.07, color: '#ffffff', bold: true, background: 'box', font: 'system', animation: 'rise' });
    }
    return { ...edit, clips, zooms: zooms.sort((a, b) => a.start - b.start), texts: texts.sort((a, b) => a.start - b.start) };
}

// ---- One-click clean-ups (no model needed: the word timings are exact) ----

/** Filler words to cut, padded a little so the cut doesn't clip the next word. */
export function fillerCuts(fillers: CaptionWord[]): Proposal[] {
    return fillers.map((w) => ({ id: newId(), type: 'cut' as const, start: Math.max(0, w.start - 0.05), end: w.end + 0.05, reason: `“${w.text}”` }));
}

/** Silences longer than `min` seconds between words, trimmed so a short natural pause remains. */
export function pauseCuts(captions: Caption[], duration: number, min = 1.2): Proposal[] {
    const words = captions.flatMap((c) => (c.words.length ? c.words : [{ start: c.start, end: c.end, text: c.text }])).sort((a, b) => a.start - b.start);
    const keep = 0.3;
    const cuts: Proposal[] = [];
    let last = 0;
    for (const word of [...words, { start: duration, end: duration, text: '' }]) {
        if (word.start - last >= min) {
            cuts.push({ id: newId(), type: 'cut', start: last + keep, end: word.start - keep, reason: `${(word.start - last).toFixed(1)} s pause` });
        }
        last = Math.max(last, word.end);
    }
    return cuts;
}
