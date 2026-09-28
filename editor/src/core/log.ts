// The editor's console: the page's errors and warnings (WebGPU validation
// errors too) and the info lines of Play mode, shown in the status bar's
// drawer and read by the assistant (get_console).

import { Emitter } from './events';

export interface LogEntry {
    level: 'error' | 'warn' | 'info';
    text: string;
    time: Date;
}

const MAX_LOGS = 300;
/** The latest entries, oldest first. */
export const logs: LogEntry[] = [];
/** 'change' after every new entry and after clearLogs(). */
export const logEvents = new Emitter<{ change: void }>();

function push(level: LogEntry['level'], args: unknown[]) {
    const text = args
        .map((a) => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'string') return a;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(' ');
    logs.push({ level, text, time: new Date() });
    if (logs.length > MAX_LOGS) logs.shift();
    logEvents.emit('change', undefined);
}

/** Mirrors console errors and warnings, and uncaught errors, into the log. */
export function captureConsole() {
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...args: unknown[]) => {
        push('error', args);
        origError(...args);
    };
    console.warn = (...args: unknown[]) => {
        push('warn', args);
        origWarn(...args);
    };
    window.addEventListener('error', (e) => push('error', [e.error ?? e.message]));
    window.addEventListener('unhandledrejection', (e) => push('error', ['Unhandled promise rejection:', e.reason]));
}

export function logInfo(text: string) {
    push('info', [text]);
}

/** Latest entries, oldest first (used by the AI tools). */
export function recentLogs(limit = 50, levels: LogEntry['level'][] = ['error', 'warn', 'info']): { level: string; text: string; time: string }[] {
    return logs
        .filter((l) => levels.includes(l.level))
        .slice(-limit)
        .map((l) => ({ level: l.level, text: l.text.slice(0, 2000), time: l.time.toISOString() }));
}

export function clearLogs() {
    logs.length = 0;
    logEvents.emit('change', undefined);
}
