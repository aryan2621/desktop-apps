import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    Captions as CaptionsIcon,
    Camera,
    ChevronLeft,
    ImageIcon,
    Mic,
    MousePointer2,
    Palette,
    Plus,
    Sparkles,
    Trash2,
    Type,
    Upload,
    Volume2,
    VolumeX,
    WandSparkles,
    ZoomIn,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button, Segmented, Select, Slider, Switch, cx } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { backgroundCss } from './render';
import { MusicPanel } from './MusicPanel';
import { HidePanel } from './HidePanel';
import { CaptionsPanel } from './CaptionsPanel';
import { AiPanel } from './AiPanel';
import { CURSOR_ANIMATIONS, SCREEN_ANIMATIONS } from './motion';
import type { CursorData, Project } from '../lib/api';
import {
    CLICK_COLORS,
    FONTS,
    fontStack,
    GRADIENTS,
    SOLID_COLORS,
    TEXT_ANIMATIONS,
    type Background,
    type CameraCorner,
    type Captions,
    type CursorStyle,
    type Edit,
    type FontKey,
    type HideRegion,
    type TextOverlay,
    type TrackLevel,
    type Zoom,
} from './model';

interface InspectorProps {
    edit: Edit;
    hasCamera: boolean;
    onChange: (change: Partial<Edit>, key: string) => void;
    selectedZoom: Zoom | null;
    hasClicks: boolean;
    onZoomChange: (zoom: Zoom, key: string) => void;
    onZoomDelete: (id: string) => void;
    onAutoZoom: () => void;
    onAddZoom: () => void;
    onApplyZoomScaleToAll: () => void;
    selectedText: TextOverlay | null;
    onAddText: () => void;
    onTextChange: (text: TextOverlay, key: string) => void;
    onTextDelete: (id: string) => void;
    hasSystemAudio: boolean;
    hasMicrophone: boolean;
    projectId: string;
    project: Project;
    projectName: string;
    selectedHide: HideRegion | null;
    onAddHide: () => void;
    onHideChange: (hide: HideRegion, key: string) => void;
    onHideDelete: (id: string) => void;
    selectedCaptionId: string | null;
    onSelectCaption: (id: string | null) => void;
    onCaptionsChange: (captions: Captions, key: string) => void;
    /** Clears the selection (the back arrow on an item's settings). */
    onDeselect: () => void;
    /** Jump to a source time. */
    onSeekSource: (source: number) => void;
    cursor: CursorData | null;
    /** Replaces the whole edit in one undo step (AI editing). */
    onReplaceEdit: (next: Edit, key: string) => void;
}

const TEXT_COLORS = ['#ffffff', '#111111', '#d97757', '#ffd200', '#ff5c7a', '#38ef7d'];
/** One-click text positions: left/centre/right × top/middle/bottom. */
const TEXT_POSITIONS = [0.12, 0.5, 0.88];
const TEXT_ROWS = ['Top', 'Middle', 'Bottom'];
const TEXT_COLUMNS = ['left', 'centre', 'right'];

type Tab = 'look' | 'zoom' | 'cursor' | 'camera' | 'audio' | 'captions' | 'annotate' | 'ai';

/**
 * The settings sidebar. Categories sit in a labelled grid at the top; selecting a zoom, text or
 * hidden area on the timeline swaps in that item's own settings (with a way back), like Screen Studio.
 */
export function Inspector(props: InspectorProps) {
    const { edit, hasCamera, onChange, selectedZoom, selectedText, selectedHide, selectedCaptionId, onDeselect } = props;
    const [tab, setTab] = useState<Tab>('look');
    useEffect(() => {
        if (selectedCaptionId) setTab('captions');
    }, [selectedCaptionId]);

    const tabs: { value: Tab; label: string; icon: ReactNode }[] = [
        { value: 'look', label: 'Look', icon: <Palette className='h-4 w-4' /> },
        { value: 'zoom', label: 'Zoom', icon: <ZoomIn className='h-4 w-4' /> },
        { value: 'cursor', label: 'Cursor', icon: <MousePointer2 className='h-4 w-4' /> },
        ...(hasCamera ? [{ value: 'camera' as Tab, label: 'Camera', icon: <Camera className='h-4 w-4' /> }] : []),
        // Always shown: background music works even on recordings without sound.
        { value: 'audio', label: 'Audio', icon: <Volume2 className='h-4 w-4' /> },
        { value: 'captions', label: 'Captions', icon: <CaptionsIcon className='h-4 w-4' /> },
        { value: 'annotate', label: 'Annotate', icon: <Type className='h-4 w-4' /> },
        { value: 'ai', label: 'AI', icon: <Sparkles className='h-4 w-4' /> },
    ];

    const item = selectedZoom ? (
        <ItemPanel title='Zoom' onBack={onDeselect} onDelete={() => props.onZoomDelete(selectedZoom.id)}>
            <ZoomSettings zoom={selectedZoom} onChange={props.onZoomChange} />
        </ItemPanel>
    ) : selectedText ? (
        <ItemPanel title='Text' onBack={onDeselect} onDelete={() => props.onTextDelete(selectedText.id)}>
            <TextSettings text={selectedText} onChange={props.onTextChange} />
        </ItemPanel>
    ) : selectedHide ? (
        <ItemPanel title='Hidden area' onBack={onDeselect} onDelete={() => props.onHideDelete(selectedHide.id)}>
            <HidePanel bare hides={edit.hides} selected={selectedHide} duration={props.project.duration} onAdd={props.onAddHide} onChange={props.onHideChange} onDelete={props.onHideDelete} />
        </ItemPanel>
    ) : null;

    return (
        <div className='flex h-full flex-col'>
            {!item && (
                <nav className='grid shrink-0 grid-cols-4 gap-1 border-b border-line p-2' role='tablist'>
                    {tabs.map((t) => {
                        const active = tab === t.value;
                        return (
                            <button
                                key={t.value}
                                role='tab'
                                aria-selected={active}
                                onClick={() => setTab(t.value)}
                                className={cx(
                                    'flex h-12 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium transition-colors',
                                    active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'
                                )}
                            >
                                {t.icon}
                                {t.label}
                            </button>
                        );
                    })}
                </nav>
            )}
            <div className='min-h-0 flex-1 overflow-y-auto p-5'>
                {item ?? (
                    <>
                        {tab === 'look' && <LookPanel {...props} />}
                        {tab === 'zoom' && <ZoomPanel {...props} />}
                        {tab === 'cursor' && <CursorPanel cursor={edit.cursor} edit={edit} onChange={onChange} />}
                        {tab === 'camera' && hasCamera && <CameraPanel edit={edit} onChange={onChange} />}
                        {tab === 'audio' && <AudioPanel {...props} />}
                        {tab === 'captions' && (
                            <CaptionsPanel
                                project={props.project}
                                projectName={props.projectName}
                                captions={edit.captions}
                                clips={edit.clips}
                                selectedId={selectedCaptionId}
                                onChange={props.onCaptionsChange}
                                onSelect={props.onSelectCaption}
                                onSeek={props.onSeekSource}
                            />
                        )}
                        {tab === 'annotate' && (
                            <div className='space-y-8'>
                                <Section icon={<Type className='h-3.5 w-3.5' />} title='Text'>
                                    <p className='text-xs text-muted'>
                                        {edit.texts.length === 0 ? 'No text yet.' : `${edit.texts.length} text${edit.texts.length === 1 ? '' : 's'} on the timeline.`} Select one on the timeline to edit
                                        it, and drag it on the preview to move it.
                                    </p>
                                    <Button className='w-full' onClick={props.onAddText}>
                                        <Plus className='h-4 w-4' /> Add text at the playhead
                                    </Button>
                                </Section>
                                <HidePanel hides={edit.hides} selected={null} duration={props.project.duration} onAdd={props.onAddHide} onChange={props.onHideChange} onDelete={props.onHideDelete} />
                            </div>
                        )}
                        {tab === 'ai' && <AiPanel project={props.project} edit={edit} cursor={props.cursor} onApply={props.onReplaceEdit} onSeek={props.onSeekSource} />}
                    </>
                )}
            </div>
        </div>
    );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

function Section({ icon, title, action, children }: { icon?: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className='space-y-3'>
            <div className='flex min-h-8 items-center justify-between'>
                <h3 className='flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted'>
                    {icon}
                    {title}
                </h3>
                {action}
            </div>
            {children}
        </section>
    );
}

/** A labelled on/off row. */
function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
    return (
        <div className='flex items-center justify-between gap-3 text-xs' title={hint}>
            <span>{label}</span>
            <Switch label={label} checked={checked} onChange={onChange} />
        </div>
    );
}

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (color: string) => void; label: string }) {
    return (
        <div className='flex flex-wrap items-center gap-2'>
            {colors.map((color) => (
                <button
                    key={color}
                    onClick={() => onChange(color)}
                    className={cx('h-6 w-6 rounded-full border border-line ring-offset-2 ring-offset-panel', value.toLowerCase() === color.toLowerCase() && 'ring-2 ring-accent')}
                    style={{ background: color }}
                    title={`${label} ${color}`}
                    aria-label={`${label} ${color}`}
                />
            ))}
            <ColorInput label='' value={value} onChange={onChange} />
        </div>
    );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <label className='flex items-center gap-1.5 text-xs text-muted' title={`${label || 'Custom'} color`}>
            <input type='color' value={value} onChange={(e) => onChange(e.target.value)} className='h-7 w-9 cursor-pointer rounded border border-line bg-transparent' />
            {label}
        </label>
    );
}

/** Header for the settings of one selected timeline item. */
function ItemPanel({ title, onBack, onDelete, children }: { title: string; onBack: () => void; onDelete: () => void; children: ReactNode }) {
    return (
        <div className='space-y-5'>
            <div className='-mx-2 -mt-2 flex items-center justify-between'>
                <button onClick={onBack} className='flex h-8 items-center gap-1 rounded-lg px-2 text-sm font-medium text-fg hover:bg-panel-2' title='Back to all settings (Esc)'>
                    <ChevronLeft className='h-4 w-4' /> {title}
                </button>
                <Button size='sm' variant='ghost' onClick={onDelete} title='Delete (⌫)'>
                    <Trash2 className='h-3.5 w-3.5' /> Delete
                </Button>
            </div>
            {children}
        </div>
    );
}

// ---- Look ----

function LookPanel({ edit, onChange, projectId, project }: InspectorProps) {
    const background = edit.background;
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const setBackground = (next: Background, key: string) => onChange({ background: next }, key);
    const chooseImage = async (file: File | undefined) => {
        if (!file) return;
        setBusy(true);
        try {
            const stored = await api.importBackground(projectId, file);
            setBackground({ type: 'image', file: stored, name: file.name, blur: background.type === 'image' ? background.blur : 0 }, 'background-image');
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setBusy(false);
            if (input.current) input.current.value = '';
        }
    };
    const kind = background.type;

    return (
        <div className='space-y-8'>
            <Section icon={<Palette className='h-3.5 w-3.5' />} title='Background'>
                <Segmented<Background['type']>
                    size='sm'
                    value={kind}
                    onChange={(next) => {
                        if (next === kind) return;
                        if (next === 'gradient') setBackground(GRADIENTS[0], 'background-type');
                        else if (next === 'color') setBackground({ type: 'color', color: background.type === 'gradient' ? background.from : SOLID_COLORS[0] }, 'background-type');
                        else input.current?.click();
                    }}
                    options={[
                        { value: 'gradient', label: 'Gradient' },
                        { value: 'color', label: 'Color' },
                        { value: 'image', label: 'Image' },
                    ]}
                />
                <input ref={input} type='file' accept='image/png,image/jpeg,image/webp,image/heic,.heic' className='hidden' onChange={(e) => chooseImage(e.target.files?.[0])} />
                {background.type === 'gradient' && (
                    <>
                        <div className='grid grid-cols-6 gap-2'>
                            {GRADIENTS.map((gradient, i) => {
                                const active = gradient.type === 'gradient' && background.from === gradient.from && background.to === gradient.to;
                                return (
                                    <button
                                        key={i}
                                        onClick={() => setBackground(gradient, 'background')}
                                        className={cx('aspect-square rounded-lg ring-offset-2 ring-offset-panel', active && 'ring-2 ring-accent')}
                                        style={{ background: backgroundCss(gradient) }}
                                        title='Use this gradient'
                                        aria-label='Use this gradient'
                                    />
                                );
                            })}
                        </div>
                        <div className='flex items-center gap-3'>
                            <ColorInput label='From' value={background.from} onChange={(from) => setBackground({ ...background, from }, 'background-from')} />
                            <ColorInput label='To' value={background.to} onChange={(to) => setBackground({ ...background, to }, 'background-to')} />
                        </div>
                        <Slider label='Angle' value={background.angle} min={0} max={360} step={5} format={(v) => `${v}°`} onChange={(angle) => setBackground({ ...background, angle }, 'background-angle')} />
                    </>
                )}
                {background.type === 'color' && <Swatches label='Background' colors={SOLID_COLORS} value={background.color} onChange={(color) => setBackground({ type: 'color', color }, 'background-color')} />}
                {background.type === 'image' && (
                    <>
                        <button
                            onClick={() => input.current?.click()}
                            disabled={busy}
                            className='group relative block aspect-video w-full overflow-hidden rounded-lg border border-line'
                            style={{ background: backgroundCss(background, project) }}
                            title='Choose another image'
                        >
                            <span className='absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100'>
                                <Upload className='h-4 w-4' /> Replace
                            </span>
                        </button>
                        <p className='flex items-center gap-2 truncate text-xs text-muted'>
                            <ImageIcon className='h-3.5 w-3.5 shrink-0' /> {background.name}
                        </p>
                        <Slider label='Blur' value={background.blur} min={0} max={1} step={0.05} format={percent} onChange={(blur) => setBackground({ ...background, blur }, 'background-blur')} />
                    </>
                )}
            </Section>

            <Section title='Frame'>
                <Slider label='Padding' value={edit.padding} min={0} max={0.25} step={0.005} format={(v) => percent(v / 0.25)} onChange={(padding) => onChange({ padding }, 'padding')} />
                <Slider label='Rounded corners' value={edit.radius} min={0} max={0.05} step={0.001} format={(v) => percent(v / 0.05)} onChange={(radius) => onChange({ radius }, 'radius')} />
                <Slider label='Shadow' value={edit.shadow} min={0} max={1} step={0.05} format={percent} onChange={(shadow) => onChange({ shadow }, 'shadow')} />
            </Section>
        </div>
    );
}

// ---- Zoom ----

function ZoomPanel({ edit, onChange, hasClicks, onAutoZoom, onAddZoom, onApplyZoomScaleToAll }: InspectorProps) {
    const autoCount = edit.zooms.filter((z) => z.auto).length;
    return (
        <div className='space-y-8'>
            <Section icon={<ZoomIn className='h-3.5 w-3.5' />} title='Zoom'>
                <p className='text-xs text-muted'>
                    {edit.zooms.length === 0 ? 'No zooms yet.' : `${edit.zooms.length} zoom${edit.zooms.length === 1 ? '' : 's'}${autoCount ? `, ${autoCount} from your clicks` : ''}.`} Click an empty spot on the
                    Zoom lane to add one, drag a zoom to move it, or select it to change it.
                </p>
                <div className='grid grid-cols-2 gap-2'>
                    <Button onClick={onAutoZoom} disabled={!hasClicks} title={hasClicks ? 'Re-create the automatic zooms from your clicks (your own zooms are kept)' : 'No clicks were recorded'}>
                        <WandSparkles className='h-4 w-4' /> Auto zoom
                    </Button>
                    <Button onClick={onAddZoom}>
                        <Plus className='h-4 w-4' /> Add zoom
                    </Button>
                </div>
                <Slider label='Zoom level' value={edit.zoomScale} min={1.2} max={4} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(zoomScale) => onChange({ zoomScale }, 'zoom-default')} />
                <div className='flex items-center justify-between gap-2'>
                    <p className='text-xs text-muted'>Used by auto zoom and new zooms.</p>
                    <Button size='sm' variant='ghost' onClick={onApplyZoomScaleToAll} disabled={edit.zooms.length === 0}>
                        Apply to all
                    </Button>
                </div>
            </Section>

            <Section title='Animation'>
                <div className='space-y-1.5'>
                    <div className='text-xs'>Camera</div>
                    <Segmented
                        size='sm'
                        value={edit.motion.screen}
                        onChange={(screen) => onChange({ motion: { ...edit.motion, screen } }, 'motion-screen')}
                        options={SCREEN_ANIMATIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
                    />
                </div>
                <Slider label='Motion blur' value={edit.motion.blur} min={0} max={1} step={0.05} format={(v) => (v === 0 ? 'Off' : percent(v))} onChange={(blur) => onChange({ motion: { ...edit.motion, blur } }, 'motion-blur')} />
                <p className='text-xs text-muted'>Zooms ease in with a spring, pan to keep the cursor in view, and glide from one zoom to the next. Blur on zooms is added in the export, so the preview stays smooth.</p>
            </Section>
        </div>
    );
}

function ZoomSettings({ zoom, onChange }: { zoom: Zoom; onChange: (zoom: Zoom, key: string) => void }) {
    const set = (partial: Partial<Zoom>, key: string) => onChange({ ...zoom, ...partial, auto: false }, key);
    return (
        <div className='space-y-5'>
            <Slider label='Zoom level' value={zoom.scale} min={1.2} max={4} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(scale) => set({ scale }, `zoom-scale-${zoom.id}`)} />
            <div className='space-y-1.5'>
                <div className='text-xs'>Focus</div>
                <Segmented
                    size='sm'
                    value={zoom.mode}
                    onChange={(mode) => set({ mode }, 'zoom-mode')}
                    options={[
                        { value: 'follow', label: 'Follow cursor', hint: 'Pan smoothly to keep the cursor in view' },
                        { value: 'fixed', label: 'Fixed point', hint: 'Stay on one spot; drag the dot on the preview' },
                    ]}
                />
            </div>
            {zoom.mode === 'fixed' && (
                <>
                    <p className='text-xs text-muted'>Drag the dot on the preview to choose where to zoom.</p>
                    <Slider label='Horizontal' value={zoom.x} min={0} max={1} step={0.01} format={percent} onChange={(x) => set({ x }, `zoom-x-${zoom.id}`)} />
                    <Slider label='Vertical' value={zoom.y} min={0} max={1} step={0.01} format={percent} onChange={(y) => set({ y }, `zoom-y-${zoom.id}`)} />
                </>
            )}
            <Toggle label='Instant' hint='Cut straight in and out instead of animating' checked={!!zoom.instant} onChange={(instant) => set({ instant }, 'zoom-instant')} />
        </div>
    );
}

// ---- Cursor ----

function CursorPanel({ cursor, edit, onChange }: { cursor: CursorStyle; edit: Edit; onChange: InspectorProps['onChange'] }) {
    const set = (partial: Partial<CursorStyle>, key: string) => onChange({ cursor: { ...cursor, ...partial } }, key);
    return (
        <div className='space-y-8'>
            <Section icon={<MousePointer2 className='h-3.5 w-3.5' />} title='Cursor' action={<Switch label='Show cursor' checked={cursor.visible} onChange={(visible) => set({ visible }, 'cursor-visible')} />}>
                {cursor.visible ? (
                    <>
                        <Segmented
                            size='sm'
                            value={cursor.shape}
                            onChange={(shape) => set({ shape }, 'cursor-shape')}
                            options={[
                                { value: 'arrow', label: 'Arrow' },
                                { value: 'hand', label: 'Hand' },
                                { value: 'dot', label: 'Dot' },
                            ]}
                        />
                        <Slider label='Size' value={cursor.size} min={0.5} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(size) => set({ size }, 'cursor-size')} />
                    </>
                ) : (
                    <p className='text-xs text-muted'>The cursor is hidden in the video. Clicks still drive auto zoom.</p>
                )}
            </Section>

            {cursor.visible && (
                <Section title='Movement'>
                    <Segmented
                        size='sm'
                        value={cursor.animation}
                        onChange={(animation) => set({ animation }, 'cursor-animation')}
                        options={CURSOR_ANIMATIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
                    />
                    <Slider label='Motion blur' value={edit.motion.blur} min={0} max={1} step={0.05} format={(v) => (v === 0 ? 'Off' : percent(v))} onChange={(blur) => onChange({ motion: { ...edit.motion, blur } }, 'motion-blur')} />
                    <Toggle label='Hide when not moving' checked={cursor.hideIdle} onChange={(hideIdle) => set({ hideIdle }, 'cursor-idle')} />
                    {cursor.hideIdle && (
                        <Slider label='Hide after' value={cursor.idleDelay} min={0.5} max={5} step={0.5} format={(v) => `${v.toFixed(1)} s`} onChange={(idleDelay) => set({ idleDelay }, 'cursor-idle-delay')} />
                    )}
                </Section>
            )}

            {cursor.visible && (
                <Section title='Clicks'>
                    <Segmented
                        size='sm'
                        value={cursor.clickStyle}
                        onChange={(clickStyle) => set({ clickStyle }, 'cursor-click')}
                        options={[
                            { value: 'ripple', label: 'Ripple' },
                            { value: 'pulse', label: 'Pulse' },
                            { value: 'none', label: 'None' },
                        ]}
                    />
                    {cursor.clickStyle !== 'none' && <Swatches label='Click color' colors={CLICK_COLORS} value={cursor.clickColor} onChange={(clickColor) => set({ clickColor }, 'cursor-click-color')} />}
                    <Toggle label='Press animation' hint='The cursor dips briefly on each click' checked={cursor.pressEffect} onChange={(pressEffect) => set({ pressEffect }, 'cursor-press')} />
                </Section>
            )}

            <Section icon={<Volume2 className='h-3.5 w-3.5' />} title='Click sound' action={<Switch label='Click sound' checked={cursor.clickSound} onChange={(clickSound) => set({ clickSound }, 'cursor-sound')} />}>
                {cursor.clickSound && (
                    <>
                        <Segmented
                            size='sm'
                            value={cursor.clickSoundType}
                            onChange={(clickSoundType) => set({ clickSoundType }, 'cursor-sound-type')}
                            options={[
                                { value: 'tick', label: 'Soft tick' },
                                { value: 'mouse', label: 'Mouse click' },
                            ]}
                        />
                        <Slider label='Volume' value={cursor.clickVolume} min={0.05} max={1} step={0.05} format={percent} onChange={(clickVolume) => set({ clickVolume }, 'cursor-volume')} />
                    </>
                )}
            </Section>
        </div>
    );
}

// ---- Camera ----

function CameraPanel({ edit, onChange }: { edit: Edit; onChange: InspectorProps['onChange'] }) {
    const camera = edit.camera;
    const set = (partial: Partial<Edit['camera']>, key: string) => onChange({ camera: { ...camera, ...partial } }, key);
    return (
        <Section icon={<Camera className='h-3.5 w-3.5' />} title='Camera' action={<Switch label='Show camera' checked={camera.visible} onChange={(visible) => set({ visible }, 'camera-visible')} />}>
            {camera.visible && (
                <>
                    <div className='space-y-1.5'>
                        <div className='text-xs'>Position</div>
                        <div className='grid grid-cols-2 gap-2'>
                            {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as CameraCorner[]).map((corner) => (
                                <button
                                    key={corner}
                                    onClick={() => set({ corner }, 'camera-corner')}
                                    className={cx('relative h-12 rounded-lg border bg-panel-2', camera.corner === corner ? 'border-accent' : 'border-line hover:border-muted')}
                                    title={corner.replace('-', ' ')}
                                    aria-label={`Camera ${corner.replace('-', ' ')}`}
                                >
                                    <span
                                        className={cx(
                                            'absolute h-3 w-3 rounded-full',
                                            camera.corner === corner ? 'bg-accent' : 'bg-muted',
                                            corner.startsWith('top') ? 'top-1.5' : 'bottom-1.5',
                                            corner.endsWith('left') ? 'left-1.5' : 'right-1.5'
                                        )}
                                    />
                                </button>
                            ))}
                        </div>
                    </div>
                    <Slider label='Size' value={camera.size} min={0.1} max={0.5} step={0.01} format={percent} onChange={(size) => set({ size }, 'camera-size')} />
                    <Segmented
                        size='sm'
                        value={camera.shape}
                        onChange={(shape) => set({ shape }, 'camera-shape')}
                        options={[
                            { value: 'circle', label: 'Circle' },
                            { value: 'rounded', label: 'Rounded' },
                        ]}
                    />
                    <Toggle label='Shrink while zoomed in' hint='The bubble gets smaller during zooms so it covers less of the screen' checked={camera.shrinkOnZoom} onChange={(shrinkOnZoom) => set({ shrinkOnZoom }, 'camera-shrink')} />
                </>
            )}
        </Section>
    );
}

// ---- Audio ----

function AudioPanel({ edit, onChange, hasMicrophone, hasSystemAudio, projectId }: InspectorProps) {
    const setLevel = (track: 'system' | 'microphone', level: TrackLevel, key: string) => onChange({ audio: { ...edit.audio, [track]: level } }, key);
    return (
        <Section icon={<Volume2 className='h-3.5 w-3.5' />} title='Audio'>
            {(
                [
                    { track: 'microphone', label: 'Microphone', icon: <Mic className='h-3.5 w-3.5' />, present: hasMicrophone },
                    { track: 'system', label: 'System audio', icon: <Volume2 className='h-3.5 w-3.5' />, present: hasSystemAudio },
                ] as const
            )
                .filter((row) => row.present)
                .map(({ track, label, icon }) => {
                    const level = edit.audio[track];
                    return (
                        <div key={track} className='space-y-2 rounded-lg border border-line bg-panel-2 p-3'>
                            <div className='flex items-center justify-between text-xs'>
                                <span className='flex items-center gap-2'>
                                    {icon}
                                    {label}
                                </span>
                                <Button
                                    size='icon'
                                    variant={level.muted ? 'danger' : 'ghost'}
                                    className='h-7 w-7'
                                    onClick={() => setLevel(track, { ...level, muted: !level.muted }, `mute-${track}`)}
                                    title={level.muted ? `Unmute ${label.toLowerCase()}` : `Mute ${label.toLowerCase()}`}
                                    aria-label={level.muted ? `Unmute ${label}` : `Mute ${label}`}
                                >
                                    {level.muted ? <VolumeX className='h-3.5 w-3.5' /> : <Volume2 className='h-3.5 w-3.5' />}
                                </Button>
                            </div>
                            <Slider label='Volume' value={level.volume} min={0} max={2} step={0.05} format={percent} onChange={(volume) => setLevel(track, { ...level, volume }, `volume-${track}`)} />
                        </div>
                    );
                })}
            <MusicPanel projectId={projectId} audio={edit.audio} onChange={(audio, key) => onChange({ audio }, key)} />
            <Slider label='Fade in' value={edit.audio.fadeIn} min={0} max={3} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(fadeIn) => onChange({ audio: { ...edit.audio, fadeIn } }, 'fade-in')} />
            <Slider label='Fade out' value={edit.audio.fadeOut} min={0} max={3} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(fadeOut) => onChange({ audio: { ...edit.audio, fadeOut } }, 'fade-out')} />
        </Section>
    );
}

// ---- Text ----

function TextSettings({ text, onChange }: { text: TextOverlay; onChange: (text: TextOverlay, key: string) => void }) {
    const set = (partial: Partial<TextOverlay>, key: string) => onChange({ ...text, ...partial }, key);
    return (
        <div className='space-y-5'>
            <textarea
                value={text.text}
                onChange={(e) => set({ text: e.target.value }, `text-${text.id}`)}
                rows={3}
                autoFocus
                placeholder='Type something…'
                className='w-full resize-none rounded-lg border border-line bg-panel-2 p-2 text-sm text-fg outline-none focus:border-accent'
                aria-label='Text'
            />
            <Select value={text.font} onChange={(e) => set({ font: e.target.value as FontKey }, 'text-font')} style={{ fontFamily: fontStack(text.font) }} title='Font' aria-label='Font'>
                {FONTS.map((font) => (
                    <option key={font.value} value={font.value} style={{ fontFamily: font.stack }}>
                        {font.label}
                    </option>
                ))}
            </Select>
            <div className='space-y-1.5'>
                <div className='text-xs'>Animation</div>
                <div className='grid grid-cols-4 gap-1 rounded-lg bg-panel-2 p-1' role='radiogroup' aria-label='Text animation'>
                    {TEXT_ANIMATIONS.map((option) => (
                        <button
                            key={option.value}
                            role='radio'
                            aria-checked={text.animation === option.value}
                            onClick={() => set({ animation: option.value }, 'text-animation')}
                            className={cx('h-7 rounded-md text-xs transition-colors', text.animation === option.value ? 'bg-accent text-white' : 'text-muted hover:bg-line hover:text-fg')}
                            title={option.hint}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>
            <div className='flex items-start gap-4'>
                <div className='grid shrink-0 grid-cols-3 gap-1 rounded-lg bg-panel-2 p-1.5' aria-label='Text position'>
                    {TEXT_POSITIONS.map((y, row) =>
                        TEXT_POSITIONS.map((x, column) => {
                            const active = Math.abs(text.x - x) < 0.03 && Math.abs(text.y - y) < 0.03;
                            const label = `${TEXT_ROWS[row]} ${TEXT_COLUMNS[column]}`;
                            return (
                                <button
                                    key={label}
                                    onClick={() => set({ x, y }, 'text-position')}
                                    className={cx('h-5 w-5 rounded', active ? 'bg-accent' : 'bg-line hover:bg-muted')}
                                    title={`Move to ${label.toLowerCase()}`}
                                    aria-label={`Move text to ${label.toLowerCase()}`}
                                />
                            );
                        })
                    )}
                </div>
                <div className='flex-1 space-y-2'>
                    <Slider label='Horizontal' value={text.x} min={0} max={1} step={0.01} format={percent} onChange={(x) => set({ x }, `text-x-${text.id}`)} />
                    <Slider label='Vertical' value={text.y} min={0} max={1} step={0.01} format={percent} onChange={(y) => set({ y }, `text-y-${text.id}`)} />
                </div>
            </div>
            <Slider label='Size' value={text.size} min={0.02} max={0.2} step={0.005} format={(v) => percent(v / 0.2)} onChange={(size) => set({ size }, `text-size-${text.id}`)} />
            <Swatches label='Text color' colors={TEXT_COLORS} value={text.color} onChange={(color) => set({ color }, 'text-color')} />
            <Toggle label='Bold' checked={text.bold} onChange={(bold) => set({ bold }, 'text-bold')} />
            <div className='space-y-1.5'>
                <div className='text-xs'>Background</div>
                <Segmented
                    size='sm'
                    value={text.background}
                    onChange={(background) => set({ background }, 'text-background')}
                    options={[
                        { value: 'none', label: 'Shadow' },
                        { value: 'box', label: 'Dark box' },
                    ]}
                />
            </div>
        </div>
    );
}

