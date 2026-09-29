import { clearLogs, logEvents, logs } from '../core/log';
import type { Editor } from '../editor';
import { onChanges, touches } from './batch';
import { clear, h } from './dom';
import { icon } from './icons';
import { toast } from './overlays';

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

/** Bottom bar: selection, autosave, fps, GPU and build info, plus the log drawer; a click on "[Name.js:12]" in it calls `openLocation`. */
export function statusbar(editor: Editor, openLocation: (file: string, line: number) => void): HTMLElement {
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
            h('button', { class: 'btn small', text: 'Clear', attrs: { type: 'button' }, on: { click: () => clearLogs() } }),
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
            const pre = h('pre', { text: l.text });
            const loc = /\[([^\]\s:]+\.(?:js|wgsl)):(\d+)\]/.exec(l.text);
            if (loc) {
                pre.classList.add('linked');
                pre.title = `Open ${loc[1]} at line ${loc[2]}`;
                pre.addEventListener('click', () => openLocation(loc[1], Number(loc[2])));
            }
            list.appendChild(h('div', { class: 'log-entry ' + l.level }, h('span', { class: 'log-time', text: l.time.toLocaleTimeString() }), pre));
        }
    };
    logEvents.on('change', renderLogs);
    renderLogs();

    const updateSelection = () => {
        const n = store.primary;
        const count = store.selection.length;
        const total = store.doc.nodes.length;
        selection.textContent = n ? (count > 1 ? `${count} selected (${n.name})` : n.name) + ` - ${total} objects` : `${total} objects`;
    };
    store.on('selection', updateSelection);
    onChanges(store, (hint) => touches(hint, 'nodes') && updateSelection());
    updateSelection();

    let warned = '';
    editor.autosave.onStatus = (s) => {
        saved.textContent = s.problem === undefined ? `Saved in browser ${s.saved.toLocaleTimeString()}` : 'Not safe in this browser';
        saved.title = s.problem ?? '';
        saved.classList.toggle('warn', !!s.problem);
        // Told once per problem; the status bar keeps showing it.
        if (s.problem && s.problem !== warned) toast(s.problem, 'error', 10000);
        warned = s.problem ?? '';
    };
    setInterval(() => {
        fps.textContent = `${editor.runtime.fps.toFixed(0)} fps`;
    }, 500);

    const playing = h('span', { class: 'status-item play-indicator', attrs: { hidden: true } });
    let playTimer = 0;
    editor.player.on('state', (st) => {
        playing.hidden = st === 'stopped';
        clearInterval(playTimer);
        const draw = () => {
            playing.replaceChildren(icon(st === 'paused' ? 'pause' : 'play', 12), h('span', { text: `${st === 'paused' ? 'Paused' : 'Playing'} ${editor.player.time.elapsed.toFixed(1)}s` }));
        };
        if (st !== 'stopped') {
            draw();
            playTimer = window.setInterval(draw, 250);
        }
    });

    const bar = h('footer', { class: 'statusbar' }, selection, playing, saved, fps, gpu, version, logButton);
    return h('div', { class: 'status-wrap' }, drawer, bar);
}
