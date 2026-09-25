import type { Editor } from '../editor';
import { clear, h } from './dom';
import { icon } from './icons';

interface LogEntry {
    level: 'error' | 'warn' | 'info';
    text: string;
    time: Date;
}

const MAX_LOGS = 300;
const logs: LogEntry[] = [];
const listeners = new Set<() => void>();

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
    for (const l of listeners) l();
}

/** Mirrors console errors/warnings (including WebGPU validation errors) into the editor. */
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

function build(): { sha: string; ref: string; repo: string; time: string } {
    try {
        return __EDITOR_BUILD__;
    } catch {
        return { sha: '', ref: '', repo: '', time: '' };
    }
}

export function buildInfo() {
    return build();
}

/** Bottom bar: selection, autosave, fps, GPU and build info, plus the log drawer. */
export function statusbar(editor: Editor): HTMLElement {
    const store = editor.store;
    const selection = h('span', { class: 'status-item grow' });
    const saved = h('span', { class: 'status-item muted', text: 'Not saved yet' });
    const fps = h('span', { class: 'status-item mono' });
    const gpu = h('span', { class: 'status-item muted ellipsis', text: editor.runtime.adapterInfo, title: 'WebGPU adapter' });
    const b = build();
    const shortSha = b.sha ? b.sha.slice(0, 7) : 'dev';
    const commitUrl = b.repo && b.sha ? `https://github.com/${b.repo}/commit/${b.sha}` : '';
    const version = commitUrl
        ? h('a', { class: 'status-item muted mono', text: shortSha, title: `Built from ${b.ref || 'branch'} at ${b.time}`, attrs: { href: commitUrl, target: '_blank', rel: 'noopener' } })
        : h('span', { class: 'status-item muted mono', text: shortSha, title: b.time ? `Built ${b.time}` : 'Local build' });

    const badge = h('span', { class: 'log-badge' });
    const logButton = h('button', { class: 'status-btn', title: 'Console', attrs: { type: 'button' } }, icon('terminal', 14), badge);
    const drawer = h('div', { class: 'log-drawer', attrs: { hidden: true } });
    const list = h('div', { class: 'log-list' });
    drawer.append(
        h(
            'div',
            { class: 'log-header' },
            h('span', { text: 'Console' }),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn small', text: 'Clear', attrs: { type: 'button' }, on: { click: () => { logs.length = 0; renderLogs(); } } }),
            h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Close console' }, on: { click: () => (drawer.hidden = true) } }, icon('close', 14)),
        ),
        list,
    );
    logButton.addEventListener('click', () => {
        drawer.hidden = !drawer.hidden;
        if (!drawer.hidden) renderLogs();
    });
    const renderLogs = () => {
        const errors = logs.filter((l) => l.level === 'error').length;
        const warns = logs.filter((l) => l.level === 'warn').length;
        badge.textContent = errors ? String(errors) : warns ? String(warns) : '';
        badge.className = 'log-badge' + (errors ? ' error' : warns ? ' warn' : '');
        if (drawer.hidden) return;
        clear(list);
        if (!logs.length) list.appendChild(h('div', { class: 'empty-hint', text: 'No messages.' }));
        for (const l of logs.slice().reverse()) {
            list.appendChild(
                h('div', { class: 'log-entry ' + l.level }, h('span', { class: 'log-time', text: l.time.toLocaleTimeString() }), h('pre', { text: l.text })),
            );
        }
    };
    listeners.add(renderLogs);
    renderLogs();

    const updateSelection = () => {
        const n = store.primary;
        const count = store.selection.length;
        const total = store.doc.nodes.length;
        selection.textContent = n ? (count > 1 ? `${count} selected (${n.name})` : n.name) + ` - ${total} objects` : `${total} objects`;
    };
    store.on('selection', updateSelection);
    store.on('change', updateSelection);
    updateSelection();

    editor.autosave.onSaved = (t) => {
        saved.textContent = `Saved in browser ${t.toLocaleTimeString()}`;
    };
    setInterval(() => {
        fps.textContent = `${editor.runtime.fps.toFixed(0)} fps`;
    }, 500);

    const bar = h('footer', { class: 'statusbar' }, selection, saved, fps, gpu, version, logButton);
    return h('div', { class: 'status-wrap' }, drawer, bar);
}
