import { useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';
import { IconButton, Kbd } from '../components/ui';

const GROUPS: { title: string; items: [string[], string][] }[] = [
    {
        title: 'Playback',
        items: [
            [['Space'], 'Play / pause'],
            [['←'], 'Back 5 seconds'],
            [['→'], 'Forward 5 seconds'],
        ],
    },
    {
        title: 'Editing',
        items: [
            [['S'], 'Mark a part to cut, then cut it'],
            [['Esc'], 'Cancel cutting'],
            [['T'], 'Add text at the playhead'],
            [['H'], 'Hide part of the screen at the playhead'],
            [['⌫'], 'Delete the selected clip, zoom, text, hidden area or caption'],
            [['⌘', 'Z'], 'Undo'],
            [['⌘', '⇧', 'Z'], 'Redo'],
        ],
    },
    {
        title: 'Timeline',
        items: [
            [['⌘', '+'], 'Zoom in'],
            [['⌘', '−'], 'Zoom out'],
            [['⌘', '0'], 'Fit the whole video'],
            [['⌥'], 'Hold while dragging to skip snapping'],
        ],
    },
    {
        title: 'App',
        items: [
            [['⌘', 'E'], 'Export or upload'],
            [['⌘', '⇧', 'R'], 'Start / stop recording (anywhere)'],
            [['?'], 'Show these shortcuts'],
        ],
    },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' || event.key === '?') {
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    return (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm' onClick={onClose}>
            <div className='w-full max-w-2xl rounded-2xl border border-line bg-panel p-6 shadow-panel' onClick={(e) => e.stopPropagation()}>
                <div className='mb-5 flex items-center justify-between'>
                    <h2 className='flex items-center gap-2 font-serif text-lg font-medium'>
                        <Keyboard className='h-4 w-4' /> Keyboard shortcuts
                    </h2>
                    <IconButton label='Close' size='icon-sm' onClick={onClose}>
                        <X className='h-4 w-4' />
                    </IconButton>
                </div>
                <div className='grid grid-cols-2 gap-x-8 gap-y-6'>
                    {GROUPS.map((group) => (
                        <section key={group.title} className='space-y-2'>
                            <h3 className='text-[11px] font-semibold uppercase tracking-wider text-subtle'>{group.title}</h3>
                            {group.items.map(([keys, action]) => (
                                <div key={action} className='flex items-center justify-between gap-4 text-sm'>
                                    <span className='text-muted'>{action}</span>
                                    <span className='flex shrink-0 gap-1'>
                                        {keys.map((key) => (
                                            <Kbd key={key}>{key}</Kbd>
                                        ))}
                                    </span>
                                </div>
                            ))}
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}
