import type { PointerEvent as ReactPointerEvent } from 'react';
import type { NormalizedRect } from './model';
import type { Rect } from './render';

const MIN_SIZE = 0.08;
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * Crop box drawn over the whole (uncropped) recording. `frame` is where the recording sits on
 * screen, in CSS pixels relative to the overlay's container.
 */
export function CropOverlay({ frame, crop, onChange }: { frame: Rect; crop: NormalizedRect; onChange: (crop: NormalizedRect) => void }) {
    const box = {
        left: frame.x + crop.x * frame.width,
        top: frame.y + crop.y * frame.height,
        width: crop.width * frame.width,
        height: crop.height * frame.height,
    };

    const start = (event: ReactPointerEvent, handle: Handle) => {
        event.stopPropagation();
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        const originX = event.clientX;
        const originY = event.clientY;
        const initial = crop;

        const move = (e: PointerEvent) => {
            const dx = (e.clientX - originX) / frame.width;
            const dy = (e.clientY - originY) / frame.height;
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
        <div className='absolute inset-0'>
            <div
                className='absolute cursor-move border-2 border-white'
                style={{ ...box, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
                onPointerDown={(e) => start(e, 'move')}
            >
                {/* Rule-of-thirds guides */}
                <div className='pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3'>
                    {Array.from({ length: 9 }).map((_, i) => (
                        <div key={i} className='border border-white/15' />
                    ))}
                </div>
                {corners.map(({ handle, className }) => (
                    <div key={handle} className={`absolute h-3 w-3 rounded-sm bg-white ${className}`} onPointerDown={(e) => start(e, handle)} />
                ))}
            </div>
        </div>
    );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
