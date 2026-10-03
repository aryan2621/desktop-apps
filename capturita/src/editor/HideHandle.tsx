import type { PointerEvent as ReactPointerEvent } from 'react';
import type { HideRegion, NormalizedRect } from './model';
import { screenRectToFrame, type Rect } from './render';

/** Smallest hide region, as a fraction of the recorded screen. */
const MIN_SIZE = 0.01;
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * Box over the selected hide region on the preview: drag it to move, drag a corner to resize.
 * `view` is the visible part of the screen and where it's drawn (see `screenView`), in CSS
 * pixels, so the box lines up even while a zoom is active.
 */
export function HideHandle({ hide, view, onChange }: { hide: HideRegion; view: { crop: NormalizedRect; content: Rect }; onChange: (rect: NormalizedRect) => void }) {
    const box = screenRectToFrame(hide, view);

    const start = (event: ReactPointerEvent, handle: Handle) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        const originX = event.clientX;
        const originY = event.clientY;
        const initial = { x: hide.x, y: hide.y, width: hide.width, height: hide.height };
        // Pixels on the preview → fraction of the recorded screen.
        const perX = view.crop.width / view.content.width;
        const perY = view.crop.height / view.content.height;

        const move = (e: PointerEvent) => {
            const dx = (e.clientX - originX) * perX;
            const dy = (e.clientY - originY) * perY;
            let { x, y, width, height } = initial;
            if (handle === 'move') {
                x = clamp(initial.x + dx, 0, 1 - width);
                y = clamp(initial.y + dy, 0, 1 - height);
            } else {
                if (handle.includes('w')) {
                    x = clamp(initial.x + dx, 0, initial.x + initial.width - MIN_SIZE);
                    width = initial.x + initial.width - x;
                }
                if (handle.includes('e')) width = clamp(initial.width + dx, MIN_SIZE, 1 - initial.x);
                if (handle.includes('n')) {
                    y = clamp(initial.y + dy, 0, initial.y + initial.height - MIN_SIZE);
                    height = initial.y + initial.height - y;
                }
                if (handle.includes('s')) height = clamp(initial.height + dy, MIN_SIZE, 1 - initial.y);
            }
            onChange({ x, y, width, height });
        };
        const up = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    };

    const corners: { handle: Handle; className: string }[] = [
        { handle: 'nw', className: '-left-1.5 -top-1.5 cursor-nwse-resize' },
        { handle: 'ne', className: '-right-1.5 -top-1.5 cursor-nesw-resize' },
        { handle: 'sw', className: '-bottom-1.5 -left-1.5 cursor-nesw-resize' },
        { handle: 'se', className: '-bottom-1.5 -right-1.5 cursor-nwse-resize' },
    ];

    return (
        <div
            className='absolute cursor-move border-2 border-dashed border-lane-hide'
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            onPointerDown={(e) => start(e, 'move')}
            title='Drag to move; drag a corner to resize'
        >
            {corners.map(({ handle, className }) => (
                <div key={handle} className={`absolute h-3 w-3 rounded-sm bg-lane-hide ${className}`} onPointerDown={(e) => start(e, handle)} />
            ))}
        </div>
    );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
