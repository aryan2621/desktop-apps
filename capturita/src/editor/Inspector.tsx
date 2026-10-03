import { useEffect, useState, type ReactNode } from 'react';
import { AudioWaveform, Ban, Captions as CaptionsIcon, EyeOff, Sparkles, Blend, Bold, Camera, Check, Circle, CircleDot, Crop, Crosshair, Frame, Layers, Mic, MousePointer2, MousePointerClick, PaintBucket, Palette, Pointer, Radio, RotateCcw, Square, Trash2, Type, Volume2, VolumeX, Wand2, ZoomIn } from 'lucide-react';
import { Button, Select, Slider, Switch, cx } from '../components/ui';
import { backgroundCss } from './render';
import { MusicPanel } from './MusicPanel';
import { HidePanel } from './HidePanel';
import { CaptionsPanel } from './CaptionsPanel';
import { AiPanel } from './AiPanel';
import type { CursorData, Project } from '../lib/api';
import { ASPECTS, FONTS, fontStack, GRADIENTS, TEXT_ANIMATIONS, type CameraCorner, type Captions, type ClickSoundType, type ClickStyle, type CursorShape, type Edit, type FontKey, type HideRegion, type TextOverlay, type TrackLevel, type Zoom } from './model';

interface InspectorProps {
    edit: Edit;
    hasCamera: boolean;
    cropping: boolean;
    onChange: (change: Partial<Edit>, key: string) => void;
    onCropToggle: () => void;
    selectedZoom: Zoom | null;
    hasClicks: boolean;
    onZoomChange: (zoom: Zoom, key: string) => void;
    onZoomDelete: (id: string) => void;
    onAutoZoom: () => void;
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
    /** Jump to a source time. */
    onSeekSource: (source: number) => void;
    cursor: CursorData | null;
    /** Replaces the whole edit in one undo step (AI editing). */
    onReplaceEdit: (next: Edit, key: string) => void;
}

const TEXT_COLORS = ['#ffffff', '#111111', '#7c5cff', '#ffd200', '#ff5c7a', '#38ef7d'];
/** One-click text positions: left/centre/right × top/middle/bottom. */
const TEXT_POSITIONS = [0.12, 0.5, 0.88];
const TEXT_ROWS = ['Top', 'Middle', 'Bottom'];
const TEXT_COLUMNS = ['left', 'centre', 'right'];

type Tab = 'ai' | 'background' | 'frame' | 'layout' | 'zoom' | 'text' | 'hide' | 'captions' | 'camera' | 'cursor' | 'audio';

export function Inspector({
    edit,
    hasCamera,
    cropping,
    onChange,
    onCropToggle,
    selectedZoom,
    hasClicks,
    onZoomChange,
    onZoomDelete,
    onAutoZoom,
    onApplyZoomScaleToAll,
    selectedText,
    onAddText,
    onTextChange,
    onTextDelete,
    hasSystemAudio,
    hasMicrophone,
    projectId,
    project,
    projectName,
    selectedHide,
    onAddHide,
    onHideChange,
    onHideDelete,
    selectedCaptionId,
    onSelectCaption,
    onCaptionsChange,
    onSeekSource,
    cursor,
    onReplaceEdit,
}: InspectorProps) {
    const [tab, setTab] = useState<Tab>('background');
    // Selecting a zoom on the timeline opens its settings.
    const selectedZoomId = selectedZoom?.id;
    useEffect(() => {
        if (selectedZoomId) setTab('zoom');
    }, [selectedZoomId]);
    const selectedTextId = selectedText?.id;
    useEffect(() => {
        if (selectedTextId) setTab('text');
    }, [selectedTextId]);
    const selectedHideId = selectedHide?.id;
    useEffect(() => {
        if (selectedHideId) setTab('hide');
    }, [selectedHideId]);
    useEffect(() => {
        if (selectedCaptionId) setTab('captions');
    }, [selectedCaptionId]);
    const tabs: { value: Tab; label: string; icon: ReactNode }[] = [
        { value: 'ai', label: 'AI editing', icon: <Sparkles className='h-4 w-4' /> },
        { value: 'background', label: 'Background', icon: <Palette className='h-4 w-4' /> },
        { value: 'frame', label: 'Frame', icon: <Frame className='h-4 w-4' /> },
        { value: 'layout', label: 'Layout & crop', icon: <Crop className='h-4 w-4' /> },
        { value: 'zoom', label: 'Zoom', icon: <ZoomIn className='h-4 w-4' /> },
        { value: 'text', label: 'Text', icon: <Type className='h-4 w-4' /> },
        { value: 'captions', label: 'Captions', icon: <CaptionsIcon className='h-4 w-4' /> },
        { value: 'hide', label: 'Hide private info', icon: <EyeOff className='h-4 w-4' /> },
        ...(hasCamera ? [{ value: 'camera' as Tab, label: 'Camera', icon: <Camera className='h-4 w-4' /> }] : []),
        { value: 'cursor', label: 'Cursor', icon: <MousePointer2 className='h-4 w-4' /> },
        // Always shown: background music works even on recordings without sound.
        { value: 'audio', label: 'Audio', icon: <Volume2 className='h-4 w-4' /> },
    ];
    const setLevel = (track: 'system' | 'microphone', level: TrackLevel, key: string) => onChange({ audio: { ...edit.audio, [track]: level } }, key);
    const cropped = edit.crop.x > 0 || edit.crop.y > 0 || edit.crop.width < 1 || edit.crop.height < 1;
    const background = edit.background;

    // Settings panel on the left, a vertical rail of categories on the right edge.
    return (
        <div className='flex h-full'>
            <div className='min-w-0 flex-1 overflow-y-auto p-5'>
                {tab === 'background' && (
                    <Section icon={<Palette className='h-3.5 w-3.5' />} title='Background'>
                        <div className='grid grid-cols-4 gap-2'>
                            {GRADIENTS.map((gradient, i) => {
                                const active =
                                    background.type === 'gradient' &&
                                    gradient.type === 'gradient' &&
                                    background.from === gradient.from &&
                                    background.to === gradient.to;
                                return (
                                    <button
                                        key={i}
                                        onClick={() => onChange({ background: gradient }, 'background')}
                                        className={cx('aspect-square rounded-lg ring-offset-2 ring-offset-panel', active && 'ring-2 ring-accent')}
                                        style={{ background: backgroundCss(gradient) }}
                                        title='Use this gradient'
                                        aria-label='Use this gradient'
                                    />
                                );
                            })}
                        </div>
                        <div className='flex items-center gap-2'>
                            <ColorInput
                                label='From'
                                value={background.type === 'gradient' ? background.from : background.color}
                                onChange={(color) =>
                                    onChange(
                                        { background: background.type === 'gradient' ? { ...background, from: color } : { type: 'color', color } },
                                        'background-from'
                                    )
                                }
                            />
                            {background.type === 'gradient' && (
                                <ColorInput label='To' value={background.to} onChange={(color) => onChange({ background: { ...background, to: color } }, 'background-to')} />
                            )}
                            <Button
                                size='icon'
                                variant='ghost'
                                className='ml-auto h-8 w-8'
                                title={background.type === 'gradient' ? 'Use a solid color' : 'Use a gradient'}
                                aria-label={background.type === 'gradient' ? 'Use a solid color' : 'Use a gradient'}
                                onClick={() =>
                                    onChange(
                                        {
                                            background:
                                                background.type === 'gradient'
                                                    ? { type: 'color', color: background.from }
                                                    : { type: 'gradient', from: background.color, to: '#ff6ec4', angle: 135 },
                                        },
                                        'background-type'
                                    )
                                }
                            >
                                {background.type === 'gradient' ? <PaintBucket className='h-4 w-4' /> : <Blend className='h-4 w-4' />}
                            </Button>
                        </div>
                        {background.type === 'gradient' && (
                            <Slider label='Angle' value={background.angle} min={0} max={360} step={5} format={(v) => `${v}°`} onChange={(angle) => onChange({ background: { ...background, angle } }, 'background-angle')} />
                        )}
                    </Section>
                )}

                {tab === 'frame' && (
                    <Section icon={<Frame className='h-3.5 w-3.5' />} title='Frame'>
                        <Slider label='Padding' value={edit.padding} min={0} max={0.25} step={0.005} format={percent} onChange={(padding) => onChange({ padding }, 'padding')} />
                        <Slider label='Corners' value={edit.radius} min={0} max={0.05} step={0.001} format={(v) => percent(v / 0.05)} onChange={(radius) => onChange({ radius }, 'radius')} />
                        <Slider label='Shadow' value={edit.shadow} min={0} max={1} step={0.05} format={percent} onChange={(shadow) => onChange({ shadow }, 'shadow')} />
                    </Section>
                )}

                {tab === 'layout' && (
                    <Section icon={<Crop className='h-3.5 w-3.5' />} title='Layout & crop'>
                        <div className='grid grid-cols-3 gap-2'>
                            {ASPECTS.map((aspect) => {
                                const active = edit.aspect === aspect.value;
                                const [w, h] = aspect.value === 'auto' ? [16, 10] : aspect.value.split(':').map(Number);
                                const scale = 18 / Math.max(w, h);
                                return (
                                    <button
                                        key={aspect.value}
                                        onClick={() => onChange({ aspect: aspect.value }, 'aspect')}
                                        className={cx(
                                            'flex h-16 flex-col items-center justify-center gap-1.5 rounded-lg border text-xs transition-colors',
                                            active ? 'border-accent bg-accent/10 text-fg' : 'border-line bg-panel-2 text-muted hover:border-line-strong hover:text-fg'
                                        )}
                                        title={aspect.value === 'auto' ? 'Same shape as the recording' : `${aspect.label} frame`}
                                    >
                                        <span
                                            className={cx('rounded-[3px] border-2', active ? 'border-accent' : 'border-current', aspect.value === 'auto' && 'border-dashed')}
                                            style={{ width: w * scale, height: h * scale }}
                                        />
                                        {aspect.label}
                                    </button>
                                );
                            })}
                        </div>
                        <div className='flex items-center gap-2'>
                            <Button
                                size='icon'
                                className='h-8 w-8'
                                variant={cropping ? 'primary' : 'secondary'}
                                onClick={onCropToggle}
                                title={cropping ? 'Finish cropping' : 'Crop the screen'}
                                aria-label={cropping ? 'Finish cropping' : 'Crop the screen'}
                            >
                                {cropping ? <Check className='h-4 w-4' /> : <Crop className='h-4 w-4' />}
                            </Button>
                            {cropped && (
                                <Button
                                    size='icon'
                                    variant='ghost'
                                    className='h-8 w-8'
                                    onClick={() => onChange({ crop: { x: 0, y: 0, width: 1, height: 1 } }, 'crop-reset')}
                                    title='Reset crop'
                                    aria-label='Reset crop'
                                >
                                    <RotateCcw className='h-3.5 w-3.5' />
                                </Button>
                            )}
                        </div>
                    </Section>
                )}

                {tab === 'zoom' && (
                    <Section
                        icon={<ZoomIn className='h-3.5 w-3.5' />}
                        title='Zoom'
                        action={
                            <Button
                                size='icon'
                                variant='ghost'
                                className='h-8 w-8'
                                onClick={onAutoZoom}
                                disabled={!hasClicks}
                                title={hasClicks ? 'Auto zoom: re-create zooms from your clicks' : 'No clicks were recorded, so there is nothing to auto zoom'}
                                aria-label='Auto zoom from clicks'
                            >
                                <Wand2 className='h-4 w-4' />
                            </Button>
                        }
                    >
                        <div className='space-y-2 rounded-lg border border-line bg-panel-2 p-3'>
                            <Slider
                                label='Default amount'
                                value={edit.zoomScale}
                                min={1.2}
                                max={4}
                                step={0.1}
                                format={(v) => `${v.toFixed(1)}×`}
                                onChange={(zoomScale) => onChange({ zoomScale }, 'zoom-default')}
                            />
                            <div className='flex items-center justify-between gap-2'>
                                <p className='text-xs text-muted'>Used by auto zoom and new zooms.</p>
                                <Button
                                    size='icon'
                                    variant='ghost'
                                    className='h-7 w-7 shrink-0'
                                    onClick={onApplyZoomScaleToAll}
                                    disabled={edit.zooms.length === 0}
                                    title='Use this amount for every zoom'
                                    aria-label='Use this amount for every zoom'
                                >
                                    <Layers className='h-3.5 w-3.5' />
                                </Button>
                            </div>
                        </div>
                        <p className='text-xs text-muted'>
                            {edit.zooms.length === 0 ? 'No zooms yet.' : `${edit.zooms.length} zoom${edit.zooms.length === 1 ? '' : 's'} on the timeline.`} Add one at the
                            playhead with the zoom button above the timeline, or select one to change it.
                        </p>
                        {selectedZoom && (
                            <div className='space-y-4 rounded-lg border border-line bg-panel-2 p-3'>
                                <div className='flex items-center justify-between'>
                                    <span className='text-xs font-medium'>Selected zoom</span>
                                    <Button
                                        size='icon'
                                        variant='ghost'
                                        className='h-7 w-7'
                                        onClick={() => onZoomDelete(selectedZoom.id)}
                                        title='Delete this zoom (⌫)'
                                        aria-label='Delete this zoom'
                                    >
                                        <Trash2 className='h-3.5 w-3.5' />
                                    </Button>
                                </div>
                                <Slider
                                    label='Amount'
                                    value={selectedZoom.scale}
                                    min={1.2}
                                    max={4}
                                    step={0.1}
                                    format={(v) => `${v.toFixed(1)}×`}
                                    onChange={(scale) => onZoomChange({ ...selectedZoom, scale, auto: false }, `zoom-scale-${selectedZoom.id}`)}
                                />
                                <div className='grid grid-cols-2 gap-1 rounded-lg bg-panel p-1'>
                                    {(
                                        [
                                            { mode: 'follow', label: 'Follow the cursor', icon: <MousePointer2 className='h-4 w-4' /> },
                                            { mode: 'fixed', label: 'Stay on a fixed point', icon: <Crosshair className='h-4 w-4' /> },
                                        ] as const
                                    ).map((option) => (
                                        <button
                                            key={option.mode}
                                            onClick={() => onZoomChange({ ...selectedZoom, mode: option.mode, auto: false }, 'zoom-mode')}
                                            className={cx(
                                                'flex h-8 items-center justify-center rounded-md',
                                                selectedZoom.mode === option.mode ? 'bg-accent text-white' : 'text-muted hover:text-fg'
                                            )}
                                            title={option.label}
                                            aria-label={option.label}
                                        >
                                            {option.icon}
                                        </button>
                                    ))}
                                </div>
                                {selectedZoom.mode === 'fixed' && (
                                    <>
                                        <Slider label='Horizontal' value={selectedZoom.x} min={0} max={1} step={0.01} format={percent} onChange={(x) => onZoomChange({ ...selectedZoom, x, auto: false }, `zoom-x-${selectedZoom.id}`)} />
                                        <Slider label='Vertical' value={selectedZoom.y} min={0} max={1} step={0.01} format={percent} onChange={(y) => onZoomChange({ ...selectedZoom, y, auto: false }, `zoom-y-${selectedZoom.id}`)} />
                                    </>
                                )}
                            </div>
                        )}
                    </Section>
                )}

                {tab === 'text' && (
                    <Section
                        icon={<Type className='h-3.5 w-3.5' />}
                        title='Text'
                        action={
                            <Button size='icon' variant='ghost' className='h-8 w-8' onClick={onAddText} title='Add text at the playhead (T)' aria-label='Add text at the playhead'>
                                <Type className='h-4 w-4' />
                            </Button>
                        }
                    >
                        {!selectedText ? (
                            <p className='text-xs text-muted'>
                                {edit.texts.length === 0 ? 'No text yet.' : `${edit.texts.length} text${edit.texts.length === 1 ? '' : 's'} on the timeline.`} Add one at the
                                playhead, or select one on the timeline to edit it. Drag text on the preview to move it.
                            </p>
                        ) : (
                            <div className='space-y-4'>
                                <textarea
                                    value={selectedText.text}
                                    onChange={(e) => onTextChange({ ...selectedText, text: e.target.value }, `text-${selectedText.id}`)}
                                    rows={3}
                                    autoFocus
                                    placeholder='Type something…'
                                    className='w-full resize-none rounded-lg border border-line bg-panel-2 p-2 text-sm text-fg outline-none focus:border-accent'
                                    aria-label='Text'
                                />
                                <Select
                                    value={selectedText.font}
                                    onChange={(e) => onTextChange({ ...selectedText, font: e.target.value as FontKey }, 'text-font')}
                                    style={{ fontFamily: fontStack(selectedText.font) }}
                                    title='Font'
                                    aria-label='Font'
                                >
                                    {FONTS.map((font) => (
                                        <option key={font.value} value={font.value} style={{ fontFamily: font.stack }}>
                                            {font.label}
                                        </option>
                                    ))}
                                </Select>
                                <div className='space-y-1.5'>
                                    <div className='text-xs text-muted'>Animation</div>
                                    <div className='grid grid-cols-4 gap-1 rounded-lg bg-panel-2 p-1' role='radiogroup' aria-label='Text animation'>
                                        {TEXT_ANIMATIONS.map((option) => (
                                            <button
                                                key={option.value}
                                                role='radio'
                                                aria-checked={selectedText.animation === option.value}
                                                onClick={() => onTextChange({ ...selectedText, animation: option.value }, 'text-animation')}
                                                className={cx(
                                                    'h-7 rounded-md text-xs transition-colors',
                                                    selectedText.animation === option.value ? 'bg-accent text-white' : 'text-muted hover:bg-line hover:text-fg'
                                                )}
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
                                                const active = Math.abs(selectedText.x - x) < 0.03 && Math.abs(selectedText.y - y) < 0.03;
                                                const label = `${TEXT_ROWS[row]} ${TEXT_COLUMNS[column]}`;
                                                return (
                                                    <button
                                                        key={label}
                                                        onClick={() => onTextChange({ ...selectedText, x, y }, 'text-position')}
                                                        className={cx('h-5 w-5 rounded', active ? 'bg-accent' : 'bg-line hover:bg-muted')}
                                                        title={`Move to ${label.toLowerCase()}`}
                                                        aria-label={`Move text to ${label.toLowerCase()}`}
                                                    />
                                                );
                                            })
                                        )}
                                    </div>
                                    <div className='flex-1 space-y-2'>
                                        <Slider
                                            label='Horizontal'
                                            value={selectedText.x}
                                            min={0}
                                            max={1}
                                            step={0.01}
                                            format={percent}
                                            onChange={(x) => onTextChange({ ...selectedText, x }, `text-x-${selectedText.id}`)}
                                        />
                                        <Slider
                                            label='Vertical'
                                            value={selectedText.y}
                                            min={0}
                                            max={1}
                                            step={0.01}
                                            format={percent}
                                            onChange={(y) => onTextChange({ ...selectedText, y }, `text-y-${selectedText.id}`)}
                                        />
                                    </div>
                                </div>
                                <Slider
                                    label='Size'
                                    value={selectedText.size}
                                    min={0.02}
                                    max={0.2}
                                    step={0.005}
                                    format={(v) => percent(v / 0.2)}
                                    onChange={(size) => onTextChange({ ...selectedText, size }, `text-size-${selectedText.id}`)}
                                />
                                <div className='flex items-center gap-2'>
                                    {TEXT_COLORS.map((color) => (
                                        <button
                                            key={color}
                                            onClick={() => onTextChange({ ...selectedText, color }, 'text-color')}
                                            className={cx('h-6 w-6 rounded-full border border-line ring-offset-2 ring-offset-panel', selectedText.color === color && 'ring-2 ring-accent')}
                                            style={{ background: color }}
                                            title={`Use ${color}`}
                                            aria-label={`Text color ${color}`}
                                        />
                                    ))}
                                    <ColorInput label='' value={selectedText.color} onChange={(color) => onTextChange({ ...selectedText, color }, 'text-color')} />
                                </div>
                                <div className='flex items-center gap-2'>
                                    <Button
                                        size='icon'
                                        className='h-8 w-8'
                                        variant={selectedText.bold ? 'primary' : 'secondary'}
                                        onClick={() => onTextChange({ ...selectedText, bold: !selectedText.bold }, 'text-bold')}
                                        title={selectedText.bold ? 'Bold: on' : 'Bold: off'}
                                        aria-label='Bold'
                                    >
                                        <Bold className='h-4 w-4' />
                                    </Button>
                                    <div className='flex-1'>
                                        <Choice<TextOverlay['background']>
                                            value={selectedText.background}
                                            onChange={(background) => onTextChange({ ...selectedText, background }, 'text-background')}
                                            options={[
                                                { value: 'none', label: 'No background (soft shadow)', icon: <Ban className='h-4 w-4' /> },
                                                { value: 'box', label: 'Dark box behind the text', icon: <Square className='h-4 w-4' /> },
                                            ]}
                                        />
                                    </div>
                                    <Button
                                        size='icon'
                                        variant='ghost'
                                        className='h-8 w-8'
                                        onClick={() => onTextDelete(selectedText.id)}
                                        title='Delete this text'
                                        aria-label='Delete this text'
                                    >
                                        <Trash2 className='h-4 w-4' />
                                    </Button>
                                </div>
                            </div>
                        )}
                    </Section>
                )}

                {tab === 'audio' && (
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
                                        <Slider
                                            label='Volume'
                                            value={level.volume}
                                            min={0}
                                            max={2}
                                            step={0.05}
                                            format={percent}
                                            onChange={(volume) => setLevel(track, { ...level, volume }, `volume-${track}`)}
                                        />
                                    </div>
                                );
                            })}
                        <MusicPanel projectId={projectId} audio={edit.audio} onChange={(audio, key) => onChange({ audio }, key)} />
                        <Slider label='Fade in' value={edit.audio.fadeIn} min={0} max={3} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(fadeIn) => onChange({ audio: { ...edit.audio, fadeIn } }, 'fade-in')} />
                        <Slider label='Fade out' value={edit.audio.fadeOut} min={0} max={3} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(fadeOut) => onChange({ audio: { ...edit.audio, fadeOut } }, 'fade-out')} />
                    </Section>
                )}

                {tab === 'camera' && hasCamera && (
                        <Section
                            icon={<Camera className='h-3.5 w-3.5' />}
                            title='Camera'
                            action={<Switch label='Show camera' checked={edit.camera.visible} onChange={(visible) => onChange({ camera: { ...edit.camera, visible } }, 'camera-visible')} />}
                        >
                            {edit.camera.visible && (
                                <>
                                    <div className='grid grid-cols-2 gap-2'>
                                        {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as CameraCorner[]).map((corner) => (
                                            <button
                                                key={corner}
                                                onClick={() => onChange({ camera: { ...edit.camera, corner } }, 'camera-corner')}
                                                className={cx(
                                                    'relative h-12 rounded-lg border bg-panel-2',
                                                    edit.camera.corner === corner ? 'border-accent' : 'border-line hover:border-muted'
                                                )}
                                                title={corner.replace('-', ' ')}
                                                aria-label={`Camera ${corner.replace('-', ' ')}`}
                                            >
                                                <span
                                                    className={cx(
                                                        'absolute h-3 w-3 rounded-full',
                                                        edit.camera.corner === corner ? 'bg-accent' : 'bg-muted',
                                                        corner.startsWith('top') ? 'top-1.5' : 'bottom-1.5',
                                                        corner.endsWith('left') ? 'left-1.5' : 'right-1.5'
                                                    )}
                                                />
                                            </button>
                                        ))}
                                    </div>
                                    <Slider label='Size' value={edit.camera.size} min={0.1} max={0.5} step={0.01} format={percent} onChange={(size) => onChange({ camera: { ...edit.camera, size } }, 'camera-size')} />
                                    <div className='grid grid-cols-2 gap-1 rounded-lg bg-panel-2 p-1'>
                                        {(['circle', 'rounded'] as const).map((shape) => (
                                            <button
                                                key={shape}
                                                onClick={() => onChange({ camera: { ...edit.camera, shape } }, 'camera-shape')}
                                                className={cx('flex h-8 items-center justify-center rounded-md', edit.camera.shape === shape ? 'bg-accent text-white' : 'text-muted hover:text-fg')}
                                                title={shape === 'circle' ? 'Circle' : 'Rounded square'}
                                                aria-label={shape === 'circle' ? 'Circle' : 'Rounded square'}
                                            >
                                                <span className={cx('h-4 w-4 border-2 border-current', shape === 'circle' ? 'rounded-full' : 'rounded')} />
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                        </Section>
                )}

                {tab === 'cursor' && (
                    <Section
                        icon={<MousePointer2 className='h-3.5 w-3.5' />}
                        title='Cursor'
                        action={<Switch label='Show cursor' checked={edit.cursor.visible} onChange={(visible) => onChange({ cursor: { ...edit.cursor, visible } }, 'cursor-visible')} />}
                    >
                        {edit.cursor.visible && (
                            <>
                                <Choice<CursorShape>
                                    value={edit.cursor.shape}
                                    onChange={(shape) => onChange({ cursor: { ...edit.cursor, shape } }, 'cursor-shape')}
                                    options={[
                                        { value: 'arrow', label: 'Arrow', icon: <MousePointer2 className='h-4 w-4' /> },
                                        { value: 'hand', label: 'Pointing hand', icon: <Pointer className='h-4 w-4' /> },
                                        { value: 'dot', label: 'Dot', icon: <Circle className='h-4 w-4' /> },
                                    ]}
                                />
                                <Slider label='Size' value={edit.cursor.size} min={0.5} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(size) => onChange({ cursor: { ...edit.cursor, size } }, 'cursor-size')} />
                                <Slider
                                    label='Smoothing'
                                    value={edit.cursor.smoothing}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    format={percent}
                                    onChange={(smoothing) => onChange({ cursor: { ...edit.cursor, smoothing } }, 'cursor-smoothing')}
                                />
                                <div className='space-y-2'>
                                    <span className='text-xs'>Click effect</span>
                                    <Choice<ClickStyle>
                                        value={edit.cursor.clickStyle}
                                        onChange={(clickStyle) => onChange({ cursor: { ...edit.cursor, clickStyle } }, 'cursor-click')}
                                        options={[
                                            { value: 'ripple', label: 'Ripple ring', icon: <Radio className='h-4 w-4' /> },
                                            { value: 'pulse', label: 'Filled pulse', icon: <CircleDot className='h-4 w-4' /> },
                                            { value: 'none', label: 'No click effect', icon: <Ban className='h-4 w-4' /> },
                                        ]}
                                    />
                                </div>
                                <div className='flex items-center justify-between text-xs'>
                                    <span>Press animation</span>
                                    <Switch
                                        label='Press animation'
                                        checked={edit.cursor.pressEffect}
                                        onChange={(pressEffect) => onChange({ cursor: { ...edit.cursor, pressEffect } }, 'cursor-press')}
                                    />
                                </div>
                            </>
                        )}
                        <div className='space-y-3 rounded-lg border border-line bg-panel-2 p-3'>
                            <div className='flex items-center justify-between text-xs'>
                                <span className='flex items-center gap-2'>
                                    <Volume2 className='h-3.5 w-3.5 text-muted' /> Click sound
                                </span>
                                <Switch
                                    label='Click sound'
                                    checked={edit.cursor.clickSound}
                                    onChange={(clickSound) => onChange({ cursor: { ...edit.cursor, clickSound } }, 'cursor-sound')}
                                />
                            </div>
                            {edit.cursor.clickSound && (
                                <Choice<ClickSoundType>
                                    value={edit.cursor.clickSoundType}
                                    onChange={(clickSoundType) => onChange({ cursor: { ...edit.cursor, clickSoundType } }, 'cursor-sound-type')}
                                    options={[
                                        { value: 'tick', label: 'Soft tick (built in)', icon: <AudioWaveform className='h-4 w-4' /> },
                                        { value: 'mouse', label: 'Mouse click (press and release)', icon: <MousePointerClick className='h-4 w-4' /> },
                                    ]}
                                />
                            )}
                            {edit.cursor.clickSound && (
                                <Slider
                                    label='Volume'
                                    value={edit.cursor.clickVolume}
                                    min={0.05}
                                    max={1}
                                    step={0.05}
                                    format={percent}
                                    onChange={(clickVolume) => onChange({ cursor: { ...edit.cursor, clickVolume } }, 'cursor-volume')}
                                />
                            )}
                        </div>
                    </Section>
                )}

                {tab === 'hide' && (
                    <HidePanel
                        hides={edit.hides}
                        selected={selectedHide}
                        duration={project.duration}
                        onAdd={onAddHide}
                        onChange={onHideChange}
                        onDelete={onHideDelete}
                    />
                )}

                {tab === 'ai' && <AiPanel project={project} edit={edit} cursor={cursor} onApply={onReplaceEdit} onSeek={onSeekSource} />}

                {tab === 'captions' && (
                    <CaptionsPanel
                        project={project}
                        projectName={projectName}
                        captions={edit.captions}
                        clips={edit.clips}
                        selectedId={selectedCaptionId}
                        onChange={onCaptionsChange}
                        onSelect={onSelectCaption}
                        onSeek={onSeekSource}
                    />
                )}
            </div>
            <nav className='flex w-[52px] shrink-0 flex-col items-center gap-1 border-l border-line bg-panel py-3' role='tablist' aria-orientation='vertical'>
                {tabs.map((item) => {
                    const active = tab === item.value;
                    return (
                        <button
                            key={item.value}
                            role='tab'
                            aria-selected={active}
                            onClick={() => setTab(item.value)}
                            title={item.label}
                            aria-label={item.label}
                            className={cx(
                                'relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                                active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'
                            )}
                        >
                            {active && <span className='absolute -left-[7px] top-2 bottom-2 w-[3px] rounded-full bg-accent' aria-hidden />}
                            {item.icon}
                        </button>
                    );
                })}
            </nav>
        </div>
    );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** A row of icon buttons for picking one option. */
function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; icon: ReactNode }[]; onChange: (value: T) => void }) {
    return (
        <div className='grid gap-1 rounded-lg bg-panel-2 p-1' style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
            {options.map((option) => (
                <button
                    key={option.value}
                    onClick={() => onChange(option.value)}
                    className={cx('flex h-8 items-center justify-center rounded-md', value === option.value ? 'bg-accent text-white' : 'text-muted hover:text-fg')}
                    title={option.label}
                    aria-label={option.label}
                >
                    {option.icon}
                </button>
            ))}
        </div>
    );
}

function Section({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className='space-y-3'>
            <div className='flex items-center justify-between'>
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


function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <label className='flex items-center gap-1.5 text-xs text-muted' title={`${label} color`}>
            <input type='color' value={value} onChange={(e) => onChange(e.target.value)} className='h-7 w-9 cursor-pointer rounded border border-line bg-transparent' />
            {label}
        </label>
    );
}
