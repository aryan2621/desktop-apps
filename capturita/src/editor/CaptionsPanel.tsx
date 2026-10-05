import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Captions as CaptionsIcon, FileDown, Highlighter, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type CaptionProgress, type Project } from '../lib/api';
import { Button, Segmented, Select, Slider, Switch, cx } from '../components/ui';
import type { TrackKind } from './audioSchedule';
import { makeCaptions, speechSources } from './captions';
import { FONTS, fontStack, retimeCaption, toSrt, type Caption, type CaptionBackground, type Captions, type Clip, type FontKey } from './model';

const LANGUAGES: [string, string][] = [
    ['auto', 'Detect automatically'],
    ['en', 'English'],
    ['hi', 'Hindi'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['pt', 'Portuguese'],
    ['it', 'Italian'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh', 'Chinese'],
    ['ar', 'Arabic'],
    ['ru', 'Russian'],
    ['bn', 'Bengali'],
    ['ta', 'Tamil'],
    ['te', 'Telugu'],
    ['mr', 'Marathi'],
    ['gu', 'Gujarati'],
    ['ur', 'Urdu'],
];
const COLORS = ['#ffffff', '#ffd200', '#111111', '#38ef7d', '#7cc4ff'];
const HIGHLIGHTS = ['#ffd200', '#38ef7d', '#ff5c7a', '#7cc4ff'];

type Sources = 'microphone' | 'system' | 'both';
const sourceKinds = (s: Sources): TrackKind[] => (s === 'both' ? ['microphone', 'system'] : [s]);

const PHASE_LABEL: Record<CaptionProgress['phase'], string> = {
    download: 'Downloading the speech model (one time)',
    load: 'Loading the speech model',
    transcribe: 'Listening to your recording',
};

const clock = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;

/** Captions made from the recording's speech, on this Mac: generate, style, edit, export. */
export function CaptionsPanel({
    project,
    projectName,
    captions,
    clips,
    selectedId,
    onChange,
    onSelect,
    onSeek,
}: {
    project: Project;
    projectName: string;
    captions: Captions;
    clips: Clip[];
    selectedId: string | null;
    onChange: (captions: Captions, key: string) => void;
    onSelect: (id: string | null) => void;
    /** Jump to a source time. */
    onSeek: (source: number) => void;
}) {
    const available = speechSources(project);
    // Your voice by default: system audio often has music or a video playing, which isn't what you said.
    const [sources, setSources] = useState<Sources>(available[0] ?? 'microphone');
    const [progress, setProgress] = useState<CaptionProgress | null>(null);
    const [modelMb, setModelMb] = useState<number | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const style = captions.style;
    const items = captions.items;

    useEffect(() => {
        api.captionModel()
            .then((m) => setModelMb(m.downloaded ? null : m.sizeMb))
            .catch(() => {});
        const un = listen<CaptionProgress>('captions-progress', (e) => setProgress(e.payload));
        return () => {
            un.then((u) => u());
        };
    }, []);

    // Selecting a caption on the timeline scrolls the list to it.
    useEffect(() => {
        if (!selectedId) return;
        listRef.current?.querySelector(`[data-caption="${selectedId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selectedId]);

    const generate = async () => {
        if (items.length > 0 && !window.confirm('Replace the current captions, including your edits?')) return;
        setProgress({ phase: modelMb ? 'download' : 'load', progress: 0 });
        try {
            const made = await makeCaptions(project, captions.language, sourceKinds(sources));
            onChange({ ...captions, items: made.items, fillers: made.fillers, visible: true }, 'captions-generate');
            setModelMb(null);
            toast.success(made.items.length ? `${made.items.length} captions made — check them below` : 'No speech found in this recording');
        } catch (error) {
            const message = errorMessage(error);
            if (message !== 'Cancelled') toast.error(message);
        } finally {
            setProgress(null);
        }
    };

    const setStyle = (patch: Partial<Captions['style']>, key: string) => onChange({ ...captions, style: { ...style, ...patch } }, key);
    const setItem = (caption: Caption, key: string) => onChange({ ...captions, items: items.map((c) => (c.id === caption.id ? caption : c)) }, key);
    const removeItem = (id: string) => {
        onChange({ ...captions, items: items.filter((c) => c.id !== id) }, 'captions-remove');
        if (selectedId === id) onSelect(null);
    };

    const saveSrt = async () => {
        try {
            const path = await api.saveExportText(projectName, 'srt', toSrt(clips, items));
            toast.success('Captions saved as .srt', { action: { label: 'Show', onClick: () => revealItemInDir(path) } });
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    const header = (
        <h3 className='flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted'>
            <CaptionsIcon className='h-3.5 w-3.5' />
            Captions
        </h3>
    );

    if (available.length === 0) {
        return (
            <section className='space-y-3'>
                {header}
                <p className='text-xs text-muted'>This recording has no sound, so there's nothing to caption. Record with your microphone or system audio on.</p>
            </section>
        );
    }

    if (progress) {
        return (
            <section className='space-y-3'>
                {header}
                <div className='space-y-2 rounded-lg bg-panel-2 p-3'>
                    <div className='flex items-center justify-between text-xs'>
                        <span className='flex items-center gap-2 text-fg'>
                            <Loader2 className='h-3.5 w-3.5 animate-spin' />
                            {PHASE_LABEL[progress.phase]}
                        </span>
                        {progress.phase !== 'load' && <span className='font-mono text-muted'>{Math.round(progress.progress * 100)}%</span>}
                    </div>
                    <div className='h-1.5 overflow-hidden rounded-full bg-line'>
                        <div className='h-full bg-accent transition-[width]' style={{ width: `${progress.phase === 'load' ? 100 : Math.round(progress.progress * 100)}%` }} />
                    </div>
                    <p className='text-xs text-muted'>Runs on this Mac — nothing is uploaded.</p>
                </div>
                <Button className='w-full' onClick={() => api.cancelTranscription()}>
                    <X className='h-4 w-4' /> Cancel
                </Button>
            </section>
        );
    }

    if (items.length === 0) {
        return (
            <section className='space-y-3'>
                {header}
                <p className='text-xs text-muted'>Turn what's said in the recording into captions, on this Mac. You can fix any word afterwards.</p>
                <label className='block space-y-1'>
                    <span className='text-xs text-muted'>Language spoken</span>
                    <Select value={captions.language} onChange={(e) => onChange({ ...captions, language: e.target.value }, 'captions-language')}>
                        {LANGUAGES.map(([value, label]) => (
                            <option key={value} value={value}>
                                {label}
                            </option>
                        ))}
                    </Select>
                </label>
                {available.length > 1 && (
                    <label className='block space-y-1'>
                        <span className='text-xs text-muted'>Whose voice</span>
                        <Select value={sources} onChange={(e) => setSources(e.target.value as Sources)}>
                            <option value='microphone'>Microphone only (you)</option>
                            <option value='both'>Microphone and system audio</option>
                            <option value='system'>System audio only (calls, videos)</option>
                        </Select>
                    </label>
                )}
                <Button variant='primary' className='w-full' onClick={generate}>
                    <CaptionsIcon className='h-4 w-4' /> Make captions
                </Button>
                {modelMb && <p className='text-xs text-muted'>The first time, this downloads the speech model ({modelMb} MB). After that it works offline.</p>}
            </section>
        );
    }

    return (
        <section className='space-y-4'>
            <div className='flex items-center justify-between'>
                {header}
                <Switch label='Show captions in the video' checked={captions.visible} onChange={(visible) => onChange({ ...captions, visible }, 'captions-visible')} />
            </div>

            <div className='space-y-3'>
                <Select value={style.font} onChange={(e) => setStyle({ font: e.target.value as FontKey }, 'captions-font')} style={{ fontFamily: fontStack(style.font) }} aria-label='Caption font'>
                    {FONTS.map((font) => (
                        <option key={font.value} value={font.value} style={{ fontFamily: font.stack }}>
                            {font.label}
                        </option>
                    ))}
                </Select>
                <Slider label='Size' value={style.size} min={0.03} max={0.09} step={0.0025} format={(v) => `${Math.round((v / 0.05) * 100)}%`} onChange={(size) => setStyle({ size }, 'captions-size')} />
                <Segmented<CaptionBackground>
                    size='sm'
                    value={style.background}
                    onChange={(background) => setStyle({ background }, 'captions-background')}
                    options={[
                        { value: 'box', label: 'Box', hint: 'Dark box behind the words' },
                        { value: 'shadow', label: 'Shadow', hint: 'Soft shadow, no box' },
                        { value: 'none', label: 'Plain', hint: 'Just the words' },
                    ]}
                />
                <Segmented<'bottom' | 'top'>
                    size='sm'
                    value={style.position}
                    onChange={(position) => setStyle({ position }, 'captions-position')}
                    options={[
                        { value: 'bottom', label: 'Bottom', hint: 'Captions at the bottom of the video' },
                        { value: 'top', label: 'Top', hint: 'Captions at the top of the video' },
                    ]}
                />
                <div className='flex items-center gap-2'>
                    {COLORS.map((color) => (
                        <button
                            key={color}
                            onClick={() => setStyle({ color }, 'captions-color')}
                            className={cx('h-6 w-6 rounded-full border border-line ring-offset-2 ring-offset-panel', style.color === color && 'ring-2 ring-accent')}
                            style={{ background: color }}
                            title={`Text colour ${color}`}
                            aria-label={`Caption colour ${color}`}
                        />
                    ))}
                    <button
                        onClick={() => setStyle({ bold: !style.bold }, 'captions-bold')}
                        className={cx('ml-auto h-7 rounded-md px-2 text-xs font-bold', style.bold ? 'bg-accent text-white' : 'bg-panel-2 text-muted hover:text-fg')}
                        title='Bold'
                        aria-pressed={style.bold}
                    >
                        B
                    </button>
                </div>
                <div className='space-y-2'>
                    <div className='flex items-center gap-2'>
                        <Highlighter className='h-4 w-4 shrink-0 text-muted' />
                        <span className='text-xs text-fg'>Highlight the word being said</span>
                        <div className='ml-auto'>
                            <Switch label='Highlight the spoken word' checked={!!style.highlight} onChange={(on) => setStyle({ highlight: on ? HIGHLIGHTS[0] : null }, 'captions-highlight')} />
                        </div>
                    </div>
                    {style.highlight && (
                        <div className='flex items-center gap-2 pl-6'>
                            {HIGHLIGHTS.map((color) => (
                                <button
                                    key={color}
                                    onClick={() => setStyle({ highlight: color }, 'captions-highlight')}
                                    className={cx('h-6 w-6 rounded-full border border-line ring-offset-2 ring-offset-panel', style.highlight === color && 'ring-2 ring-accent')}
                                    style={{ background: color }}
                                    title={`Highlight colour ${color}`}
                                    aria-label={`Highlight colour ${color}`}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className='flex gap-2'>
                <Button className='flex-1' onClick={saveSrt} title='Save as a subtitle file for YouTube and video players'>
                    <FileDown className='h-4 w-4' /> Save .srt
                </Button>
                <Button variant='ghost' onClick={generate} title='Make the captions again from the audio'>
                    <RefreshCw className='h-4 w-4' /> Redo
                </Button>
            </div>

            <div className='space-y-1'>
                <div className='flex justify-between text-xs text-muted'>
                    <span>{items.length} captions — click a time to jump there</span>
                </div>
                <div ref={listRef} className='max-h-[46vh] space-y-1 overflow-y-auto pr-1'>
                    {items.map((caption) => (
                        <div
                            key={caption.id}
                            data-caption={caption.id}
                            className={cx('group flex gap-2 rounded-lg border p-1.5', caption.id === selectedId ? 'border-lane-caption bg-lane-caption/10' : 'border-transparent hover:bg-panel-2')}
                        >
                            <button
                                className='mt-1 w-10 shrink-0 text-left font-mono text-[11px] text-muted hover:text-fg'
                                onClick={() => {
                                    onSelect(caption.id);
                                    onSeek(caption.start + 0.05);
                                }}
                                title='Jump to this caption'
                            >
                                {clock(caption.start)}
                            </button>
                            <AutoTextarea
                                value={caption.text}
                                onFocus={() => onSelect(caption.id)}
                                onChange={(e) => setItem(retimeCaption(caption, e.target.value), `caption-${caption.id}`)}
                                className='min-w-0 flex-1 resize-none overflow-hidden rounded-md bg-transparent px-1.5 py-1 text-sm leading-snug text-fg outline-none focus:bg-panel-2'
                                aria-label={`Caption at ${clock(caption.start)}`}
                            />
                            <button
                                onClick={() => removeItem(caption.id)}
                                className='h-6 w-6 shrink-0 rounded text-muted opacity-0 hover:text-fg group-hover:opacity-100'
                                title='Delete this caption'
                                aria-label='Delete this caption'
                            >
                                <Trash2 className='mx-auto h-3.5 w-3.5' />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

/** A textarea that grows to fit its text, so captions never show a scrollbar. */
function AutoTextarea({ value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const fit = () => {
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
        };
        fit();
        // Refit when the panel changes width (the text wraps differently).
        const observer = new ResizeObserver(fit);
        observer.observe(el);
        return () => observer.disconnect();
    }, [value]);
    return <textarea ref={ref} rows={1} value={value} {...props} />;
}
