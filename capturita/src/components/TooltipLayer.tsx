import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const SHOW_DELAY_MS = 350;
const EDGE_MARGIN = 8;
const TARGETS = 'button, [role="tab"], [role="switch"], select, input[type="color"], input[type="range"], [title], [data-tooltip]';

interface Tip {
    text: string;
    x: number;
    top: number;
    bottom: number;
}

/**
 * One tooltip for the whole app. Hovering any button or control shows its `title` (or
 * `aria-label`) in a styled bubble; the browser's own title tooltip is slow and faint in
 * WebKit, so `title` attributes are moved to `data-tooltip` on first hover.
 */
export function TooltipLayer() {
    const [tip, setTip] = useState<Tip | null>(null);
    const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let current: HTMLElement | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const hide = () => {
            clearTimeout(timer);
            current = null;
            setTip(null);
        };

        const over = (event: PointerEvent) => {
            const element = (event.target as HTMLElement | null)?.closest<HTMLElement>(TARGETS) ?? null;
            if (element === current) return;
            hide();
            if (!element) return;
            current = element;
            if (element.hasAttribute('title')) {
                element.dataset.tooltip = element.getAttribute('title') ?? '';
                element.removeAttribute('title');
            }
            const text = (element.dataset.tooltip || element.getAttribute('aria-label') || '').trim();
            // Buttons that already say the same thing in their label don't need a tooltip.
            if (!text || text === element.textContent?.trim()) return;
            timer = setTimeout(() => {
                const rect = element.getBoundingClientRect();
                setTip({ text, x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
            }, SHOW_DELAY_MS);
        };

        document.addEventListener('pointerover', over);
        document.addEventListener('pointerdown', hide, true);
        document.addEventListener('keydown', hide, true);
        document.addEventListener('scroll', hide, true);
        window.addEventListener('blur', hide);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('pointerover', over);
            document.removeEventListener('pointerdown', hide, true);
            document.removeEventListener('keydown', hide, true);
            document.removeEventListener('scroll', hide, true);
            window.removeEventListener('blur', hide);
        };
    }, []);

    // Place above the control, or below it near the top of the window, and keep it on screen.
    useLayoutEffect(() => {
        const bubble = bubbleRef.current;
        if (!tip || !bubble) {
            setPlacement(null);
            return;
        }
        const { width, height } = bubble.getBoundingClientRect();
        const left = Math.min(window.innerWidth - width - EDGE_MARGIN, Math.max(EDGE_MARGIN, tip.x - width / 2));
        const above = tip.top - height - 6;
        setPlacement({ left, top: above >= EDGE_MARGIN ? above : tip.bottom + 6 });
    }, [tip]);

    if (!tip) return null;
    return (
        <div
            ref={bubbleRef}
            role='tooltip'
            className='pointer-events-none fixed z-[1000] max-w-xs rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fg shadow-lg'
            style={placement ? { left: placement.left, top: placement.top } : { left: -9999, top: -9999 }}
        >
            {tip.text}
        </div>
    );
}
