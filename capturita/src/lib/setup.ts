// First-run setup progress, kept in localStorage. Losing it only means setup shows again.

export type SetupStep = 'welcome' | 'permissions' | 'captions' | 'done';

export const SETUP_STEPS: SetupStep[] = ['welcome', 'permissions', 'captions', 'done'];

const DONE_KEY = 'capturita.setup.done';
const RESUME_KEY = 'capturita.setup.resume';

const read = (key: string) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const write = (key: string, value: string | null) => {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // Storage unavailable: setup simply shows again next time.
    }
};

export const setupDone = () => read(DONE_KEY) === '1';

export function finishSetup() {
    write(DONE_KEY, '1');
    write(RESUME_KEY, null);
}

/** The step to reopen at after the app restarts (macOS only reports screen access after a restart). */
export function resumeStep(): SetupStep | null {
    const step = read(RESUME_KEY) as SetupStep | null;
    return step && SETUP_STEPS.includes(step) ? step : null;
}

export function setResumeStep(step: SetupStep | null) {
    write(RESUME_KEY, step);
}
