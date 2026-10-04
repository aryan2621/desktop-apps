import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openPath } from '@tauri-apps/plugin-opener';
import { FolderOpen, ListChecks } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, type Permissions, type Project } from '../lib/api';
import { PermissionsBanner } from '../components/PermissionsBanner';
import { SetupFlow } from '../components/SetupFlow';
import { resumeStep, setResumeStep, setupDone, type SetupStep } from '../lib/setup';
import { RecorderPanel } from '../components/RecorderPanel';
import { RecordingsList } from '../components/RecordingsList';
import { EditorView } from './EditorView';
import { IconButton } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

export function MainWindow() {
    const [permissions, setPermissions] = useState<Permissions | null>(null);
    const [recordings, setRecordings] = useState<Project[]>([]);
    const [editing, setEditing] = useState<Project | null>(null);
    // First launch (or a restart in the middle of setup) opens setup; the header reopens it later.
    const [setup, setSetup] = useState<SetupStep | null>(() => resumeStep() ?? (setupDone() ? null : 'welcome'));
    useEffect(() => {
        if (setup) setResumeStep(null);
    }, [setup]);
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

    if (editing) {
        return (
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
        );
    }

    return (
        <div className='flex h-full flex-col'>
            <header className='flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5'>
                <span className='flex h-7 w-7 items-center justify-center rounded-lg bg-accent shadow-sm'>
                    <span className='h-2.5 w-2.5 rounded-full bg-white' />
                </span>
                <span className='font-serif text-[17px] font-medium tracking-tight'>Capturita</span>
                <div className='ml-auto flex items-center gap-2'>
                    <IconButton label='Setup: permissions and caption model' onClick={() => setSetup('welcome')}>
                        <ListChecks className='h-4 w-4' />
                    </IconButton>
                    <ThemeToggle />
                    <IconButton label='Open the recordings folder' onClick={async () => openPath(await api.recordingsDir())}>
                        <FolderOpen className='h-4 w-4' />
                    </IconButton>
                </div>
            </header>

            <main className='flex min-h-0 flex-1 gap-6 p-6'>
                <div className='flex w-[420px] shrink-0 flex-col gap-4'>
                    {permissions && <PermissionsBanner permissions={permissions} onChange={setPermissions} />}
                    <RecorderPanel permissions={permissions} onPermissionsChange={setPermissions} />
                </div>
                <section className='flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto'>
                    <div className='flex items-baseline gap-2'>
                        <h2 className='font-serif text-xl font-medium tracking-tight'>Recordings</h2>
                        {recordings.length > 0 && <span className='text-sm text-subtle'>{recordings.length}</span>}
                    </div>
                    <RecordingsList recordings={recordings} onOpen={setEditing} onDeleted={refreshRecordings} />
                </section>
            </main>

            {setup && <SetupFlow initialStep={setup} onClose={() => setSetup(null)} onPermissionsChange={setPermissions} />}
        </div>
    );
}
