import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type SelectHTMLAttributes,
} from 'react';

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'record';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const variants: Record<Variant, string> = {
    primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
    secondary: 'bg-panel-2 text-fg hover:bg-raised border border-line',
    ghost: 'text-muted hover:text-fg hover:bg-panel-2',
    subtle: 'bg-panel-2 text-fg hover:bg-raised',
    danger: 'bg-danger-soft text-danger-fg hover:bg-danger/25',
    record: 'bg-record text-white hover:bg-record-hover shadow-lg shadow-red-500/20',
};

const sizes: Record<Size, string> = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-9 px-4 text-sm',
    lg: 'h-11 px-6 text-sm',
    icon: 'h-9 w-9',
    'icon-sm': 'h-8 w-8',
};

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
    return (
        <button
            className={cx(
                'inline-flex shrink-0 cursor-default items-center justify-center gap-2 rounded-lg font-medium transition-colors',
                'disabled:opacity-40 disabled:hover:bg-transparent',
                variants[variant],
                sizes[size],
                className
            )}
            {...props}
        />
    );
}

/** Icon-only button. `label` is required: it becomes the tooltip and the accessible name. */
export function IconButton({
    label,
    variant = 'ghost',
    size = 'icon',
    children,
    ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'aria-label'> & { label: string; variant?: Variant; size?: 'icon' | 'icon-sm' }) {
    return (
        <Button variant={variant} size={size} title={label} aria-label={label} {...props}>
            {children}
        </Button>
    );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            className={cx(
                'h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-sm text-fg outline-none transition-colors hover:border-line-strong focus:border-accent',
                className
            )}
            {...props}
        >
            {children}
        </select>
    );
}

export function Switch({
    checked,
    onChange,
    disabled,
    label,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    /** Shown as the tooltip and read by screen readers. */
    label: string;
}) {
    return (
        <button
            role='switch'
            aria-checked={checked}
            aria-label={label}
            title={`${label}: ${checked ? 'on' : 'off'}`}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40', checked ? 'bg-accent' : 'bg-line-strong')}
        >
            <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
        </button>
    );
}

export function Field({ label, icon, children, hint }: { label: string; icon?: ReactNode; children: ReactNode; hint?: ReactNode }) {
    return (
        <div className='space-y-2'>
            <div className='flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-subtle'>
                {icon}
                {label}
            </div>
            {children}
            {hint && <p className='text-xs text-muted'>{hint}</p>}
        </div>
    );
}

/**
 * One-of-many choice. The selected option is marked by an indicator that glides between
 * options (disabled by the reduced-motion setting via index.css).
 */
export function Segmented<T extends string | number>({
    value,
    options,
    onChange,
    size = 'md',
}: {
    value: T;
    options: { value: T; label?: string; icon?: ReactNode; hint?: string }[];
    onChange: (value: T) => void;
    size?: 'sm' | 'md';
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
    const index = options.findIndex((option) => option.value === value);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const place = () => {
            const button = container?.children[index + 1] as HTMLElement | undefined;
            setIndicator(button ? { left: button.offsetLeft, width: button.offsetWidth } : null);
        };
        place();
        if (!container) return;
        const observer = new ResizeObserver(place);
        observer.observe(container);
        return () => observer.disconnect();
    }, [index, options.length]);

    return (
        <div
            ref={containerRef}
            className='relative grid rounded-lg bg-panel-2 p-1'
            style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
            role='radiogroup'
        >
            <span
                aria-hidden
                className='absolute top-1 bottom-1 rounded-md bg-accent shadow-sm transition-[left,width] duration-[240ms] ease-in-out'
                style={indicator ? { left: indicator.left, width: indicator.width } : { opacity: 0 }}
            />
            {options.map((option) => {
                const active = option.value === value;
                return (
                    <button
                        key={String(option.value)}
                        role='radio'
                        aria-checked={active}
                        title={option.hint ?? option.label}
                        aria-label={option.label ? undefined : option.hint}
                        onClick={() => onChange(option.value)}
                        className={cx(
                            'relative z-10 flex items-center justify-center gap-1.5 rounded-md transition-colors',
                            size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
                            active ? 'text-accent-fg' : 'text-muted hover:text-fg'
                        )}
                    >
                        {option.icon}
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

/** A range input with a filled track. */
export function RangeInput({ value, min, max, className, style, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'min' | 'max'> & { value: number; min: number; max: number }) {
    const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
    return (
        <input
            type='range'
            value={value}
            min={min}
            max={max}
            className={cx('slider', className)}
            style={{ ...style, ['--fill' as string]: `${Math.min(100, Math.max(0, fill))}%` }}
            {...props}
        />
    );
}

/** A labelled slider with its current value on the right. */
export function Slider({
    label,
    value,
    min,
    max,
    step,
    format,
    onChange,
    disabled,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    format: (value: number) => string;
    onChange: (value: number) => void;
    disabled?: boolean;
}) {
    return (
        <label className='block space-y-1'>
            <div className='flex justify-between text-xs'>
                <span className='text-fg'>{label}</span>
                <span className='font-mono text-muted'>{format(value)}</span>
            </div>
            <RangeInput value={value} min={min} max={max} step={step} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} title={`${label}: ${format(value)}`} />
        </label>
    );
}

export function Kbd({ children }: { children: ReactNode }) {
    return <kbd className='inline-flex min-w-5 items-center justify-center rounded border border-line bg-panel-2 px-1.5 font-mono text-[11px] text-muted'>{children}</kbd>;
}

/**
 * A small floating panel anchored to its trigger. Closes on outside click or Esc.
 * `trigger` receives the open state and a toggle function.
 */
export function Popover({
    trigger,
    children,
    align = 'start',
    side = 'bottom',
}: {
    trigger: (open: boolean, toggle: () => void) => ReactNode;
    children: ReactNode | ((close: () => void) => ReactNode);
    align?: 'start' | 'end' | 'center';
    side?: 'top' | 'bottom';
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const close = () => setOpen(false);

    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (!ref.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('pointerdown', onPointer, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);

    return (
        <div ref={ref} className='relative'>
            {trigger(open, () => setOpen((o) => !o))}
            {open && (
                <div
                    className={cx(
                        'absolute z-40 min-w-56 rounded-xl border border-line bg-panel p-2 shadow-panel',
                        side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
                        align === 'start' && 'left-0',
                        align === 'end' && 'right-0',
                        align === 'center' && 'left-1/2 -translate-x-1/2'
                    )}
                >
                    {typeof children === 'function' ? children(close) : children}
                </div>
            )}
        </div>
    );
}

export { cx };
