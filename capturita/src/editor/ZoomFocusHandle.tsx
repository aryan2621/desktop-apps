import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Zoom } from './model';
import type { Rect } from './render';

/**
 * The area a fixed-point zoom will show, drawn over the un-zoomed preview. Drag it to choose
 * where to zoom. `frame` is where the (cropped) screen sits in the preview, in CSS pixels.
 */
export function ZoomFocusHandle({ zoom, frame, onMove }: { zoom: Zoom; frame: Rect; onMove: (x: number, y: number) => void }) {
    const size = 1 / zoom.scale;
    // Same placement as the camera: the focus point is centred unless that would leave the screen.
    const anchor = (p: number) => (size >= 0.999 ? 0.5 : Math.min(1, Math.max(0, (p - size / 2) / (1 - size))));
    const left = anchor(zoom.x) * (1 - size);
    const top = anchor(zoom.y) * (1 - size);

    const start = (event: ReactPointerEvent) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        const originX = event.clientX;
        const originY = event.clientY;
        // Start from the box's visible centre, so dragging from an edge doesn't jump.
        const initial = { x: left + size / 2, y: top + size / 2 };
        const move = (e: PointerEvent) => {
            const x = Math.min(1 - size / 2, Math.max(size / 2, initial.x + (e.clientX - originX) / frame.width));
            const y = Math.min(1 - size / 2, Math.max(size / 2, initial.y + (e.clientY - originY) / frame.height));
            onMove(x, y);
        };
        const up = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    };

    return (
        <div className='pointer-events-none absolute overflow-hidden' style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
            <div
                className='pointer-events-auto absolute cursor-move rounded-md border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]'
                style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${size * 100}%`, height: `${size * 100}%` }}
                onPointerDown={start}
                title='Drag to choose where to zoom'
            >
                <span className='absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow' />
                <span className='absolute left-1.5 top-1 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-accent-fg'>{zoom.scale.toFixed(1)}×</span>
            </div>
        </div>
    );
}
