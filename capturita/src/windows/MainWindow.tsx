import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openPath } from '@tauri-apps/plugin-opener';
import { FolderOpen, LayoutGrid, List, Plus, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Permissions, type Project } from '../lib/api';
import { PermissionsBanner } from '../components/PermissionsBanner';
import { SetupFlow } from '../components/SetupFlow';
import { resumeStep, setResumeStep, setupDone, type SetupStep } from '../lib/setup';
import { RecorderPanel } from '../components/RecorderPanel';
import { EmptyLibrary, LibraryHeader, RecordingsList, type LibraryView } from '../components/RecordingsList';
import { EditorView } from './EditorView';
import { Button, IconButton, Segmented } from '../components/ui';
import { SettingsDialog } from '../components/SettingsDialog';

const VIEW_KEY = 'capturita.library.view';

function loadView(): LibraryView {
    try {
        return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards';
    } catch {
        return 'cards';
    }
}

export function MainWindow() {
    const [permissions, setPermissions] = useState<Permissions | null>(null);
    const [recordings, setRecordings] = useState<Project[]>([]);
    const [editing, setEditing] = useState<Project | null>(null);
    // First launch (or a restart in the middle of setup) opens setup; the header reopens it later.
    const [setup, setSetup] = useState<SetupStep | null>(() => resumeStep() ?? (setupDone() ? null : 'welcome'));
    useEffect(() => {
        if (setup) setResumeStep(null);
    }, [setup]);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [recorderOpen, setRecorderOpen] = useState(false);
    const [view, setView] = useState<LibraryView>(loadView);
    const changeView = (next: LibraryView) => {
        setView(next);
        try {
            localStorage.setItem(VIEW_KEY, next);
        } catch {
            // The view just won't be remembered.
        }
    };
    // The main window is hidden while recording, so recorder warnings are shown once it ends.
    const pendingWarnings = useRef<string[]>([]);

    const refreshRecordings = useCallback(() => {
        api.listRecordings()
            .then(setRecordings)
            .catch((error) => toast.error(errorMessage(error)));
    }, []);

    const refreshPermissions = useCallback(() => {
        api.permissions()
            .then(setPermissions)
            .catch((error) => toast.error(errorMessage(error)));
    }, []);

    useEffect(() => {
        refreshPermissions();
        refreshRecordings();

        const listeners = [
            listen<{ event: string; data: { message?: string } }>('recorder-event', ({ payload }) => {
                if (payload.event === 'warning' && payload.data?.message) pendingWarnings.current.push(payload.data.message);
            }),
            listen<Project>('recording-finished', (event) => {
                setRecorderOpen(false);
                toast.success('Recording saved');
                pendingWarnings.current.splice(0).forEach((message) => toast.warning(message));
                refreshRecordings();
                setEditing(event.payload);
            }),
            listen<string>('recording-error', (event) => {
                pendingWarnings.current = [];
                toast.error(event.payload);
            }),
            // Permissions may change in System Settings while the app is in the background.
            getCurrentWindow().onFocusChanged(({ payload: focused }) => focused && refreshPermissions()),
        ];
        return () => {
            listeners.forEach((listener) => listener.then((unlisten) => unlisten()));
        };
    }, [refreshPermissions, refreshRecordings]);

    // Always mounted, only hidden (also under the editor): it owns the recording settings and answers ⌘⇧R.
    const recorder = (
        <RecorderDialog open={recorderOpen} onClose={() => setRecorderOpen(false)}>
            <RecorderPanel
                permissions={permissions}
                onPermissionsChange={setPermissions}
                visible={recorderOpen}
                onStarted={() => setRecorderOpen(false)}
                onNotReady={() => {
                    // ⌘⇧R from another app: bring Capturita forward so the missing choice can be made.
                    setRecorderOpen(true);
                    const window = getCurrentWindow();
                    window.unminimize().then(() => window.show()).then(() => window.setFocus()).catch(() => {});
                }}
                onClose={() => setRecorderOpen(false)}
            />
        </RecorderDialog>
    );

    if (editing) {
        return (
            <>
            <EditorView
                // A fresh editor per project: no state (edit, music, dialogs) carries over when a
                // new recording opens while another project is being edited.
                key={editing.id}
                project={editing}
                onClose={() => {
                    setEditing(null);
                    refreshRecordings();
                }}
            />
            {recorder}
            </>
        );
    }

    // Same shape as the editor branch ([page, recorder]), so the recorder keeps its state when the editor opens or closes.
    return (
        <>
        <div className='flex h-full flex-col'>
            <header className='flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5'>
                <span className='flex h-7 w-7 items-center justify-center rounded-lg bg-accent shadow-sm'>
                    <span className='h-2.5 w-2.5 rounded-full bg-white' />
                </span>
                <span className='font-serif text-[17px] font-medium tracking-tight'>Capturita</span>
                <div className='ml-auto flex items-center gap-2'>
                    <Button variant='primary' size='sm' onClick={() => setRecorderOpen(true)} title='New recording (or press ⌘⇧R anywhere)'>
                        <Plus className='h-4 w-4' /> New recording
                    </Button>
                    <IconButton label='Open the recordings folder' onClick={async () => openPath(await api.recordingsDir())}>
                        <FolderOpen className='h-4 w-4' />
                    </IconButton>
                    <IconButton label='Settings' onClick={() => setSettingsOpen(true)}>
                        <Settings className='h-4 w-4' />
                    </IconButton>
                </div>
            </header>

            <main className='flex min-h-0 flex-1 flex-col gap-4 p-6'>
                {permissions && <PermissionsBanner permissions={permissions} onChange={setPermissions} />}
                {recordings.length === 0 ? (
                    <section className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto'>
                        <LibraryHeader recordings={recordings} />
                        <EmptyLibrary onNew={() => setRecorderOpen(true)} />
                    </section>
                ) : (
                    <section className='flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1'>
                        <div className='flex items-center justify-between gap-3'>
                            <LibraryHeader recordings={recordings} />
                            <div className='w-[92px]'>
                                <Segmented<LibraryView>
                                    size='sm'
                                    value={view}
                                    onChange={changeView}
                                    options={[
                                        { value: 'cards', icon: <LayoutGrid className='h-3.5 w-3.5' />, hint: 'Show as a grid' },
                                        { value: 'table', icon: <List className='h-3.5 w-3.5' />, hint: 'Show as a list' },
                                    ]}
                                />
                            </div>
                        </div>
                        <RecordingsList recordings={recordings} view={view} onOpen={setEditing} onDeleted={refreshRecordings} />
                    </section>
                )}
            </main>

            {settingsOpen && (
                <SettingsDialog
                    onClose={() => setSettingsOpen(false)}
                    onRunSetup={() => {
                        setSettingsOpen(false);
                        setSetup('welcome');
                    }}
                />
            )}
            {setup && <SetupFlow initialStep={setup} onClose={() => setSetup(null)} onPermissionsChange={setPermissions} onStartRecording={() => setRecorderOpen(true)} />}
        </div>
        {recorder}
        </>
    );
}

function RecorderDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
    useEffect(() => {
        if (!open) return;
        // Bubble phase: an open menu inside (which handles Esc in the capture phase) closes first.
        const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    return (
        <div
            data-recorder-open={open || undefined}
            className={open ? 'fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm' : 'hidden'}
            onPointerDown={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className='flex h-[min(640px,100%)] w-full max-w-[880px] flex-col'>{children}</div>
        </div>
    );
}
