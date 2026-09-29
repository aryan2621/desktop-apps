import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import { MainWindow } from './windows/MainWindow';
import { TooltipLayer } from './components/TooltipLayer';
import { initTheme, useTheme } from './lib/theme';
import './index.css';

initTheme();

function ThemedToaster() {
    const { theme } = useTheme();
    return <Toaster theme={theme} position='bottom-right' richColors />;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <MainWindow />
        <ThemedToaster />
        <TooltipLayer />
    </React.StrictMode>
);
