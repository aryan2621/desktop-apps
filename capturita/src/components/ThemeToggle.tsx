import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemeChoice } from '../lib/theme';
import { Segmented } from './ui';

/** System / Light / Dark switch for the header. */
export function ThemeToggle() {
    const { choice, setChoice } = useTheme();
    return (
        <div className='w-[120px]'>
            <Segmented<ThemeChoice>
                size='sm'
                value={choice}
                onChange={setChoice}
                options={[
                    { value: 'system', icon: <Monitor className='h-3.5 w-3.5' />, hint: 'Theme: follow macOS' },
                    { value: 'light', icon: <Sun className='h-3.5 w-3.5' />, hint: 'Theme: light' },
                    { value: 'dark', icon: <Moon className='h-3.5 w-3.5' />, hint: 'Theme: dark' },
                ]}
            />
        </div>
    );
}
