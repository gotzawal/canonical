import { formatBytes } from '../core/assets';
import { clearLogs, logEvents, logs } from '../core/log';
import type { Editor } from '../editor';
import { onChanges, touches } from './batch';
import { clear, h } from './dom';
import { icon } from './icons';
import { showMenu, toast } from './overlays';
import { viewportMenu, viewportSummary } from './viewportMenu';

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
    // The frame rate; a click sets the viewport's frame rate limit and resolution.
    const fps = h('button', { class: 'status-btn status-item mono', attrs: { type: 'button' } });
    const fpsTitle = () => (fps.title = `The viewport draws ${viewportSummary(store)}. Click to change.`);
    fps.addEventListener('click', () => {
        const r = fps.getBoundingClientRect();
        showMenu(viewportMenu(store, true), r.left, r.top - 4);
    });
    store.on('prefs', fpsTitle);
    fpsTitle();
    // What a frame costs: draw calls and the GPU memory the editor asked for (a span: the fps button stays the only button here).
    const cost = h('span', { class: 'status-item muted mono gpu-cost', attrs: { hidden: !editor.runtime.stats } });
    // A click opens the Profiler, which breaks both down.
    cost.addEventListener('click', () => editor.emit('show-profiler', undefined));
    const gpu = h('span', { class: 'status-item muted ellipsis', text: editor.runtime.adapterInfo, title: 'WebGPU adapter' });
    // Textures and models being compressed for the game in the background (derive/).
    const compressing = h('span', { class: 'status-item muted compressing', attrs: { hidden: true } });
    const showCompressing = () => {
        const n = editor.derived.pending;
        const models = editor.derived.pendingModels;
        const count = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
        compressing.hidden = n === 0;
        compressing.textContent = `Compressing ${[n - models ? count(n - models, 'texture') : '', models ? count(models, 'model') : ''].filter(Boolean).join(' and ')}`;
        compressing.title = store.playing
            ? 'Compression waits while the game plays.'
            : 'Making the compressed copies games ship: GPU-compressed textures (KTX2), and models with those textures and packed geometry. The view shows each texture copy once it is made.';
    };
    editor.derived.queue.on('change', showCompressing);
    store.on('playing', showCompressing);
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
        const stats = editor.runtime.stats;
        if (stats) {
            // The busiest of the last frames, so a frame that skipped passes does not read as less.
            const s = stats.snapshot(30);
            const f = s.peak;
            const m = s.memory;
            const count = (n: number) => n.toLocaleString('en-US');
            cost.textContent = `${count(f.draws)} draws · ${formatBytes(m.stable)}`;
            cost.title = [
                `Per frame: ${count(f.draws)} draw calls in ${count(f.renderPasses)} render passes, ${count(f.triangles)} triangles, ${count(f.pipelines + f.bindGroups)} pipeline and bind group changes, ${s.cpu.median.toFixed(1)} ms of CPU for the engine (median).`,
                `GPU memory the editor asked for (an estimate): ${formatBytes(m.stable)}. Scene textures ${formatBytes(m.textures.image.bytes + m.textures.data.bytes)}, shadow maps ${formatBytes(m.textures.shadow.bytes)}, sky and environment maps ${formatBytes(m.textures.environment.bytes)}, render targets ${formatBytes(m.textures.target.bytes)}, compute outputs ${formatBytes(m.textures.other.bytes)}, buffers ${formatBytes(m.buffers.vertex.bytes + m.buffers.index.bytes + m.buffers.uniform.bytes + m.buffers.storage.bytes + m.buffers.other.bytes)}.`,
                'Click to open the Profiler: time per pass, every texture and the download size.',
            ].join('\n');
        }
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

    const bar = h('footer', { class: 'statusbar' }, selection, playing, saved, compressing, fps, cost, gpu, version, logButton);
    return h('div', { class: 'status-wrap' }, drawer, bar);
}
