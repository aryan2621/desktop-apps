import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Check, Download, FastForward, Loader2, Scissors, Sparkles, Type, Wand2, X, ZoomIn } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type CaptionProgress, type CursorData, type Project } from '../lib/api';
import { Button, cx } from '../components/ui';
import { askAi, applyProposals, fillerCuts, pauseCuts, type Proposal } from './aiEdit';
import { hasVoice, makeCaptions } from './captions';
import type { Edit } from './model';

const EXAMPLES = ['Cut the part where I talk about pricing', 'Remove anything off-topic', 'Speed up the parts where nothing happens', 'Add a title at the start', 'Zoom in when I click'];

const ICONS = { cut: Scissors, speed: FastForward, zoom: ZoomIn, text: Type };
const VERB = { cut: 'Cut', speed: 'Speed up', zoom: 'Zoom', text: 'Title' };

const clock = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;

type Busy = { label: string; progress: number | null } | null;

/** Edit by asking: the AI reads the transcript and proposes edits to review and apply. */
export function AiPanel({
    project,
    edit,
    cursor,
    onApply,
    onSeek,
}: {
    project: Project;
    edit: Edit;
    cursor: CursorData | null;
    /** Replaces the edit in one undo step. */
    onApply: (next: Edit, key: string) => void;
    /** Jump to a source time. */
    onSeek: (source: number) => void;
}) {
    const [model, setModel] = useState<{ name: string; downloaded: boolean; sizeMb: number } | null>(null);
    const [download, setDownload] = useState<number | null>(null);
    const [prompt, setPrompt] = useState('');
    const [busy, setBusy] = useState<Busy>(null);
    const [result, setResult] = useState<{ summary: string; proposals: Proposal[] } | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const hasSpeech = hasVoice(project);
    const transcribed = edit.captions.items.length > 0;

    useEffect(() => {
        api.aiModel().then(setModel).catch(() => {});
        const un = listen<number>('ai-progress', (e) => setDownload(e.payload));
        const unCaptions = listen<CaptionProgress>('captions-progress', (e) =>
            setBusy((b) => (b ? { label: e.payload.phase === 'download' ? 'Downloading the speech model (one time)' : 'Reading what you said', progress: e.payload.phase === 'load' ? null : e.payload.progress } : b))
        );
        return () => {
            un.then((u) => u());
            unCaptions.then((u) => u());
        };
    }, []);

    const fillers = useMemo(() => fillerCuts(edit.captions.fillers ?? []), [edit.captions.fillers]);
    const pauses = useMemo(() => pauseCuts(edit.captions.items, project.duration), [edit.captions.items, project.duration]);

    const startDownload = async () => {
        setDownload(0);
        try {
            await api.downloadAiModel();
            setModel((m) => (m ? { ...m, downloaded: true } : m));
        } catch (error) {
            if (errorMessage(error) !== 'Cancelled') toast.error(errorMessage(error));
        } finally {
            setDownload(null);
        }
    };

    /** The AI needs the transcript; make it (as hidden captions) if there isn't one yet. */
    const ensureTranscript = async (): Promise<Edit> => {
        if (transcribed) return edit;
        setBusy({ label: 'Reading what you said', progress: 0 });
        const made = await makeCaptions(project, edit.captions.language);
        const next = { ...edit, captions: { ...edit.captions, items: made.items, fillers: made.fillers, visible: false } };
        onApply(next, 'ai-transcript');
        return next;
    };

    const review = (summary: string, proposals: Proposal[]) => {
        setResult({ summary, proposals });
        setChosen(new Set(proposals.map((p) => p.id)));
    };

    const ask = async (request = prompt) => {
        if (!request.trim()) return;
        setResult(null);
        try {
            const current = await ensureTranscript();
            setBusy({ label: 'Thinking', progress: null });
            const answer = await askAi(request.trim(), current, project, cursor);
            review(answer.summary || (answer.proposals.length ? 'Here’s what I’d change.' : 'Nothing to change for that request.'), answer.proposals);
        } catch (error) {
            if (errorMessage(error) !== 'Cancelled') toast.error(errorMessage(error));
        } finally {
            setBusy(null);
        }
    };

    const cleanup = async (kind: 'fillers' | 'pauses') => {
        try {
            const current = await ensureTranscript();
            const proposals = kind === 'fillers' ? fillerCuts(current.captions.fillers ?? []) : pauseCuts(current.captions.items, project.duration);
            review(proposals.length ? `Found ${proposals.length} ${kind === 'fillers' ? 'filler words' : 'long pauses'}.` : `No ${kind === 'fillers' ? 'filler words' : 'long pauses'} found.`, proposals);
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setBusy(null);
        }
    };

    const apply = () => {
        if (!result) return;
        const picked = result.proposals.filter((p) => chosen.has(p.id));
        onApply(applyProposals(edit, picked), `ai-apply-${Date.now()}`);
        toast.success(`${picked.length} edit${picked.length === 1 ? '' : 's'} applied — ⌘Z to undo`);
        setResult(null);
        setPrompt('');
    };

    const header = (
        <h3 className='flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted'>
            <Sparkles className='h-3.5 w-3.5' />
            AI editing
        </h3>
    );

    if (!hasSpeech) {
        return (
            <section className='space-y-3'>
                {header}
                <p className='text-xs text-muted'>AI editing works from what you say, and this recording has no microphone. Turn the microphone on in the recorder next time.</p>
            </section>
        );
    }

    if (model && !model.downloaded) {
        return (
            <section className='space-y-3'>
                {header}
                <p className='text-xs text-muted'>
                    Describe an edit — “cut the part about pricing”, “add a title” — and the AI proposes it for you to check. It runs on this Mac; the model
                    ({model.name}) downloads once ({(model.sizeMb / 1000).toFixed(1)} GB). Pick another in Settings.
                </p>
                {download === null ? (
                    <Button variant='primary' className='w-full' onClick={startDownload}>
                        <Download className='h-4 w-4' /> Download the AI model
                    </Button>
                ) : (
                    <div className='space-y-2 rounded-lg bg-panel-2 p-3'>
                        <div className='flex justify-between text-xs'>
                            <span className='flex items-center gap-2 text-fg'>
                                <Loader2 className='h-3.5 w-3.5 animate-spin' /> Downloading the AI model
                            </span>
                            <span className='font-mono text-muted'>{Math.round(download * 100)}%</span>
                        </div>
                        <div className='h-1.5 overflow-hidden rounded-full bg-line'>
                            <div className='h-full bg-accent transition-[width]' style={{ width: `${Math.round(download * 100)}%` }} />
                        </div>
                        <Button variant='ghost' size='sm' className='w-full' onClick={() => api.cancelAiDownload()}>
                            Cancel
                        </Button>
                    </div>
                )}
            </section>
        );
    }

    return (
        <section className='space-y-4'>
            {header}

            {busy ? (
                <div className='space-y-2 rounded-lg bg-panel-2 p-3'>
                    <div className='flex justify-between text-xs'>
                        <span className='flex items-center gap-2 text-fg'>
                            <Loader2 className='h-3.5 w-3.5 animate-spin' /> {busy.label}…
                        </span>
                        {busy.progress !== null && <span className='font-mono text-muted'>{Math.round(busy.progress * 100)}%</span>}
                    </div>
                    {busy.progress !== null && (
                        <div className='h-1.5 overflow-hidden rounded-full bg-line'>
                            <div className='h-full bg-accent transition-[width]' style={{ width: `${Math.round(busy.progress * 100)}%` }} />
                        </div>
                    )}
                </div>
            ) : result ? (
                <div className='space-y-3'>
                    <p className='text-sm text-fg'>{result.summary}</p>
                    {result.proposals.length > 0 && (
                        <>
                            <div className='max-h-[40vh] space-y-1 overflow-y-auto pr-1'>
                                {result.proposals.map((p) => {
                                    const Icon = ICONS[p.type];
                                    const on = chosen.has(p.id);
                                    return (
                                        <div key={p.id} className={cx('flex items-start gap-2 rounded-lg border p-2', on ? 'border-accent/50 bg-accent/10' : 'border-line opacity-60')}>
                                            <button
                                                role='checkbox'
                                                aria-checked={on}
                                                onClick={() => setChosen((s) => (s.has(p.id) ? new Set([...s].filter((id) => id !== p.id)) : new Set(s).add(p.id)))}
                                                className={cx('mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border', on ? 'border-accent bg-accent text-white' : 'border-line-strong')}
                                                aria-label={on ? 'Leave this edit out' : 'Include this edit'}
                                            >
                                                {on && <Check className='h-3 w-3' />}
                                            </button>
                                            <div className='min-w-0 flex-1 text-xs'>
                                                <div className='flex items-center gap-1.5 text-fg'>
                                                    <Icon className='h-3.5 w-3.5 text-muted' />
                                                    <span className='font-medium'>
                                                        {VERB[p.type]}
                                                        {p.type === 'speed' && ` ${p.speed}×`}
                                                        {p.type === 'text' && ` “${p.text}”`}
                                                    </span>
                                                    <button className='ml-auto font-mono text-muted hover:text-fg' onClick={() => onSeek(p.start)} title='Jump there'>
                                                        {clock(p.start)}–{clock(p.end)}
                                                    </button>
                                                </div>
                                                {p.reason && <p className='mt-0.5 text-muted'>{p.reason}</p>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <p className='text-xs text-muted'>The AI can be wrong — untick anything you don't want. You can undo with ⌘Z.</p>
                        </>
                    )}
                    <div className='flex gap-2'>
                        {result.proposals.length > 0 && (
                            <Button variant='primary' className='flex-1' onClick={apply} disabled={chosen.size === 0}>
                                <Check className='h-4 w-4' /> Apply {chosen.size}
                            </Button>
                        )}
                        <Button variant='ghost' className={result.proposals.length ? '' : 'flex-1'} onClick={() => setResult(null)}>
                            <X className='h-4 w-4' /> {result.proposals.length ? 'Discard' : 'Back'}
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <div className='space-y-2'>
                        <textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    ask();
                                }
                            }}
                            rows={3}
                            placeholder='Describe an edit, e.g. “cut the part where I talk about pricing”'
                            className='w-full resize-none rounded-lg border border-line bg-panel-2 p-2 text-sm text-fg outline-none focus:border-accent'
                            aria-label='What should the AI change?'
                        />
                        <Button variant='primary' className='w-full' onClick={() => ask()} disabled={!prompt.trim()}>
                            <Wand2 className='h-4 w-4' /> Suggest edits
                        </Button>
                    </div>
                    <div className='flex flex-wrap gap-1.5'>
                        {EXAMPLES.map((example) => (
                            <button key={example} onClick={() => ask(example)} className='rounded-full bg-panel-2 px-2.5 py-1 text-xs text-muted hover:bg-line hover:text-fg'>
                                {example}
                            </button>
                        ))}
                    </div>
                    <div className='space-y-1.5 border-t border-line pt-3'>
                        <div className='text-xs text-muted'>Quick clean-ups</div>
                        <div className='grid grid-cols-2 gap-2'>
                            <Button size='sm' onClick={() => cleanup('fillers')} title='Cut “um”, “uh” and similar'>
                                Filler words{transcribed && edit.captions.fillers ? ` (${fillers.length})` : ''}
                            </Button>
                            <Button size='sm' onClick={() => cleanup('pauses')} title='Shorten silences longer than 1.2 seconds'>
                                Long pauses{transcribed ? ` (${pauses.length})` : ''}
                            </Button>
                        </div>
                        {transcribed && !edit.captions.fillers && <p className='text-xs text-muted'>Redo the captions to find filler words in this recording.</p>}
                    </div>
                    {!transcribed && <p className='text-xs text-muted'>The first request reads the recording's speech on this Mac (like captions, but hidden).</p>}
                </>
            )}
        </section>
    );
}
