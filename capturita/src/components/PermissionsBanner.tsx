import { RotateCw, ShieldAlert } from 'lucide-react';
import { api, type Permissions } from '../lib/api';
import { Button } from './ui';

/** Screen recording is the one permission Capturita can't work without. */
export function PermissionsBanner({ permissions, onChange }: { permissions: Permissions; onChange: (p: Permissions) => void }) {
    if (permissions.screen === 'granted') return null;

    return (
        <div className='flex items-start gap-4 rounded-2xl border border-warning/30 bg-warning-soft p-4'>
            <ShieldAlert className='mt-0.5 h-5 w-5 shrink-0 text-warning' />
            <div className='flex-1 space-y-1'>
                <p className='font-medium'>Allow screen recording</p>
                <p className='text-sm text-muted'>
                    Click Allow, then turn on Capturita in System Settings → Privacy & Security → Screen & System Audio Recording, and restart
                    Capturita.
                </p>
                <p className='text-sm text-muted'>
                    Already on there? A new build of the app needs permission again: select Capturita in that list, remove it with −, then
                    click Allow here.
                </p>
                <div className='flex gap-2 pt-2'>
                    <Button
                        variant='primary'
                        size='sm'
                        onClick={async () => onChange(await api.requestPermission('screen'))}
                        title='Ask macOS for screen recording permission'
                    >
                        Allow
                    </Button>
                    <Button size='icon' className='h-8 w-8' onClick={() => api.restart()} title='Restart Capturita' aria-label='Restart Capturita'>
                        <RotateCw className='h-3.5 w-3.5' />
                    </Button>
                </div>
            </div>
        </div>
    );
}
