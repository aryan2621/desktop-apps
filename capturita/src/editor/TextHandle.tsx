import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TextOverlay } from './model';
import { measureText } from './render';

let measuringContext: CanvasRenderingContext2D | null = null;

/**
 * Dashed box over the selected text on the preview; drag it to move the text.
 * `width`/`height` are the preview frame's size in CSS pixels.
 */
export function TextHandle({ text, width, height, onMove }: { text: TextOverlay; width: number; height: number; onMove: (x: number, y: number) => void }) {
    measuringContext ??= document.createElement('canvas').getContext('2d');
    if (!measuringContext || !text.text.trim()) return null;
    const { box } = measureText(measuringContext, text, width, height);

    const start = (event: ReactPointerEvent) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        const originX = event.clientX;
        const originY = event.clientY;
        const initial = { x: text.x, y: text.y };
        const move = (e: PointerEvent) => {
            const x = Math.min(1, Math.max(0, initial.x + (e.clientX - originX) / width));
            const y = Math.min(1, Math.max(0, initial.y + (e.clientY - originY) / height));
            onMove(x, y);
        };
        const up = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    };

    const pad = 6;
    return (
        <div
            className='absolute cursor-move rounded border-2 border-dashed border-lane-text'
            style={{ left: box.x - pad, top: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
            onPointerDown={start}
            title='Drag to move the text'
        />
    );
}
