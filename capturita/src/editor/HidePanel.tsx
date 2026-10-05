import { EyeOff, Grid3x3, Droplets, ShieldAlert, Square, Trash2, Maximize2 } from 'lucide-react';
import { Button, cx } from '../components/ui';
import { HIDE_STYLES, type HideRegion, type HideStyle } from './model';

const ICONS: Record<HideStyle, typeof Grid3x3> = { pixelate: Grid3x3, blur: Droplets, solid: Square };

/** Settings for hiding private parts of the screen (emails, keys, chats…). */
export function HidePanel({
    bare = false,
    hides,
    selected,
    duration,
    onAdd,
    onChange,
    onDelete,
}: {
    /** Leave out the section header (when shown under the selected item's own header). */
    bare?: boolean;
    hides: HideRegion[];
    selected: HideRegion | null;
    /** Length of the recording, for "whole video". */
    duration: number;
    onAdd: () => void;
    onChange: (hide: HideRegion, key: string) => void;
    onDelete: (id: string) => void;
}) {
    return (
        <section className='space-y-3'>
            {!bare && (
                <div className='flex min-h-8 items-center justify-between'>
                    <h3 className='flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted'>
                        <EyeOff className='h-3.5 w-3.5' />
                        Hide private info
                    </h3>
                </div>
            )}

            {!selected ? (
                <div className='space-y-3'>
                    <p className='text-xs text-muted'>
                        {hides.length === 0 ? 'Nothing hidden yet.' : `${hides.length} hidden area${hides.length === 1 ? '' : 's'} on the timeline.`} Cover emails, passwords, keys
                        or chats: add a box at the playhead, drag it over the private part on the preview, and set how long it stays on the timeline.
                    </p>
                    <Button className='w-full' onClick={onAdd} title='Hide part of the screen at the playhead (H)'>
                        <EyeOff className='h-4 w-4' /> Hide part of the screen
                    </Button>
                </div>
            ) : (
                <div className='space-y-4'>
                    <div className='space-y-1.5'>
                        <div className='text-xs text-muted'>Style</div>
                        <div className='grid grid-cols-3 gap-1 rounded-lg bg-panel-2 p-1' role='radiogroup' aria-label='How to hide it'>
                            {HIDE_STYLES.map((option) => {
                                const Icon = ICONS[option.value];
                                const active = selected.style === option.value;
                                return (
                                    <button
                                        key={option.value}
                                        role='radio'
                                        aria-checked={active}
                                        onClick={() => onChange({ ...selected, style: option.value }, 'hide-style')}
                                        className={cx('flex h-14 flex-col items-center justify-center gap-1 rounded-md text-xs transition-colors', active ? 'bg-accent text-white' : 'text-muted hover:bg-line hover:text-fg')}
                                        title={option.hint}
                                    >
                                        <Icon className='h-4 w-4' />
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {selected.style !== 'solid' && (
                        <p className='flex gap-2 rounded-lg bg-panel-2 p-2.5 text-xs text-muted'>
                            <ShieldAlert className='mt-0.5 h-3.5 w-3.5 shrink-0 text-lane-hide' />
                            For passwords, API keys and card numbers use Solid: blurred or pixelated text can sometimes be partly recovered.
                        </p>
                    )}
                    <div className='flex gap-2'>
                        <Button
                            className='flex-1'
                            onClick={() => onChange({ ...selected, start: 0, end: duration }, 'hide-whole')}
                            disabled={selected.start <= 0 && selected.end >= duration}
                            title='Keep it hidden from the first frame to the last'
                        >
                            <Maximize2 className='h-4 w-4' /> Whole video
                        </Button>
                        {!bare && (
                            <Button variant='ghost' onClick={() => onDelete(selected.id)} title='Remove this hidden area (⌫)'>
                                <Trash2 className='h-4 w-4' /> Remove
                            </Button>
                        )}
                    </div>
                    <p className='text-xs text-muted'>Drag the box on the preview to move it, or a corner to resize. It follows zooms and crops, and is baked into every export.</p>
                </div>
            )}
        </section>
    );
}
