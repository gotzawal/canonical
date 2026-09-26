// Standalone game player. It runs a scene built with File > Build & Deploy
// (game.json next to the page), or with ?preview the scene the editor hands
// over through localStorage. It is the editor's engine layer and Play mode
// without the editor UI, so a game plays the way it does in the editor.

import './player.css';
import { GAME_FILE, PREVIEW_KEY, type GameFile, type PreviewData } from '../build/gameFile';
import { setAssetResolver } from '../core/assets';
import { Store } from '../core/store';
import type { CameraState, SceneDoc } from '../core/types';
import { Picker } from '../engine/picking';
import { RenderGraphController } from '../engine/renderGraph';
import { Runtime } from '../engine/runtime';
import { ShaderManager } from '../engine/shaders';
import { SceneSync } from '../engine/sync';
import { ScriptCompiler } from '../play/compiler';
import { Player, type ScriptIssue } from '../play/player';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { CameraController } from '../viewport/cameraController';

interface Game {
    title: string;
    doc: SceneDoc;
    camera?: CameraState;
    /** False when the editor had the scene's scripts paused (previews only). */
    trusted: boolean;
    preview: boolean;
}

async function loadGame(): Promise<Game> {
    const params = new URLSearchParams(location.search);
    if (params.has('preview')) {
        let data: PreviewData | null = null;
        try {
            data = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null');
        } catch { /* reported below */ }
        if (!data?.scene) throw new Error('There is nothing to preview. Start a preview from the editor with File > Build & Deploy > Run.');
        // Assets come from this browser's IndexedDB, which the editor shares.
        return { title: data.title, doc: data.scene, camera: data.camera, trusted: data.trusted !== false, preview: true };
    }
    const url = new URL(GAME_FILE, location.href);
    // Revalidate so a redeployed game is picked up right away.
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${GAME_FILE} could not be loaded (${res.status} ${res.statusText}).`);
    let game: GameFile;
    try {
        game = await res.json();
    } catch {
        throw new Error(`${GAME_FILE} is not valid JSON.`);
    }
    if (game?.format !== 'canonical-game' || !game.scene) throw new Error(`${GAME_FILE} is not a Canonical game.`);
    const files = game.files ?? {};
    setAssetResolver((meta) => (files[meta.id] ? new URL(files[meta.id], url).href : null));
    return { title: game.title, doc: game.scene, camera: game.camera, trusted: true, preview: false };
}

async function main() {
    const root = document.getElementById('player')!;
    // Inline size: the engine pins a canvas without one to its 300 x 150 default.
    const canvas = h('canvas', { class: 'player-canvas', style: 'width:100%;height:100%', attrs: { tabindex: 0 } });
    const status = h('span', { class: 'player-status', text: 'Loading...' });
    const title = h('div', { class: 'player-title' });
    const loading = h('div', { class: 'player-loading' }, title, h('div', { class: 'player-spinner' }), status);
    root.append(canvas, loading);

    if (!('gpu' in navigator)) {
        fail(root, 'WebGPU is required', 'This browser does not expose WebGPU.', true);
        return;
    }

    let game: Game;
    try {
        game = await loadGame();
    } catch (e: any) {
        fail(root, 'The game could not be loaded', e?.message || String(e));
        return;
    }
    const name = game.title || game.doc.name || 'Canonical Game';
    document.title = game.preview ? `${name} (Preview)` : name;
    title.textContent = name;
    status.textContent = 'Starting WebGPU...';

    let runtime: Runtime;
    try {
        runtime = await Runtime.create(canvas);
    } catch (e: any) {
        console.error(e);
        fail(root, 'WebGPU is required', e?.message || String(e), true);
        return;
    }
    runtime.setGridVisible(false);

    const store = new Store(game.doc);
    if (game.camera) store.camera = { ...store.camera, ...game.camera };
    const shaders = new ShaderManager(runtime, store);
    const sync = new SceneSync(runtime, store, shaders);
    const picker = new Picker(runtime, sync, store);
    // The view the game was built from, for scenes without a camera node.
    const view = new CameraController(runtime, store, picker);
    const compiler = new ScriptCompiler(store, game.trusted);
    const player = new Player(runtime, store, sync, picker, compiler);
    new RenderGraphController(runtime, store, shaders, sync);
    store.on('change', (hint) => sync.sync(hint));
    sync.sync();

    const models = Array.from(sync.entries.values()).filter((e) => e.model).length;
    if (models) status.textContent = `Loading ${models} model${models === 1 ? '' : 's'}...`;
    else status.textContent = 'Loading...';
    await shaders.whenIdle();
    await sync.whenLoaded();
    // Models with custom shaders on their slots may have started more compiles.
    await shaders.whenIdle();
    await nextFrames(runtime, 2);

    const debug = game.preview || new URLSearchParams(location.search).has('debug');
    if (debug) showIssues(root, player, !game.trusted && game.doc.scripts.length > 0);
    player.play();
    bindInput(canvas, player, view);
    addFullscreenButton(root);
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 400);
    canvas.focus({ preventScroll: true });
    (window as any).__player = { runtime, store, sync, player };
}

function nextFrames(runtime: Runtime, count: number): Promise<void> {
    return new Promise((resolve) => {
        let left = count;
        const off = runtime.onFrame(() => {
            if (--left > 0) return;
            off();
            resolve();
        });
    });
}

/**
 * Keys go to the scripts; the left button (every button when the game has a
 * camera node) too. Without a camera node the right button orbits the view,
 * the middle button (or Shift + right) pans and the wheel zooms.
 */
function bindInput(el: HTMLElement, player: Player, view: CameraController) {
    const local = (e: { clientX: number; clientY: number }): [number, number] => {
        const r = el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    };
    let drag: { mode: 'play' | 'orbit' | 'pan'; id: number; x: number; y: number } | null = null;

    el.addEventListener('pointerdown', (e) => {
        el.focus({ preventScroll: true });
        if (drag) return;
        const [x, y] = local(e);
        el.setPointerCapture(e.pointerId);
        if (e.button === 0 || player.usesGameCamera) {
            drag = { mode: 'play', id: e.pointerId, x, y };
            player.pointerEvent('down', x, y, e.button);
        } else {
            drag = { mode: e.button === 2 && !e.shiftKey ? 'orbit' : 'pan', id: e.pointerId, x, y };
        }
    });
    el.addEventListener('pointermove', (e) => {
        const [x, y] = local(e);
        if (!drag || drag.id === e.pointerId) player.pointerEvent('move', x, y, e.button);
        if (!drag || drag.id !== e.pointerId) return;
        if (drag.mode === 'orbit') view.orbit(x - drag.x, y - drag.y);
        else if (drag.mode === 'pan') view.pan(drag.x, drag.y, x, y);
        drag.x = x;
        drag.y = y;
    });
    const up = (e: PointerEvent) => {
        if (!drag || drag.id !== e.pointerId) return;
        const [x, y] = local(e);
        if (drag.mode === 'play') player.pointerEvent('up', x, y, e.button);
        drag = null;
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
        'wheel',
        (e) => {
            e.preventDefault();
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 16;
            else if (e.deltaMode === 2) dy *= 400;
            player.wheelEvent(dy);
            if (player.usesGameCamera) return;
            const [x, y] = local(e);
            view.dolly(Math.max(-1, Math.min(1, dy * 0.0012)), x, y);
        },
        { passive: false },
    );

    window.addEventListener('keydown', (e) => {
        player.keyEvent(e, true);
        // Keep browser shortcuts (reload, zoom, dev tools, fullscreen); the
        // game gets the rest without the page scrolling on arrows or space.
        if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => player.keyEvent(e, false));
}

function addFullscreenButton(root: HTMLElement) {
    if (!document.fullscreenEnabled) return;
    const btn = h('button', { class: 'player-fullscreen', attrs: { type: 'button' } });
    const update = () => {
        const on = !!document.fullscreenElement;
        btn.replaceChildren(icon(on ? 'minimize' : 'maximize', 18));
        btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
        btn.setAttribute('aria-label', btn.title);
    };
    btn.addEventListener('click', () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', update);
    update();
    // Out of the way while playing: shown when the mouse moves.
    let timer = 0;
    const wake = () => {
        btn.classList.add('visible');
        clearTimeout(timer);
        timer = window.setTimeout(() => btn.classList.remove('visible'), 2500);
    };
    window.addEventListener('pointermove', wake);
    wake();
    root.append(btn);
}

/** Script errors on screen, for previews and ?debug. */
function showIssues(root: HTMLElement, player: Player, paused: boolean) {
    const list = h('div', { class: 'player-issues-list' });
    const panel = h(
        'div',
        { class: 'player-issues', attrs: { role: 'log', hidden: true } },
        h(
            'div',
            { class: 'player-issues-head' },
            h('span', { text: 'Script messages' }),
            h('button', { class: 'player-issues-close', title: 'Hide', attrs: { type: 'button', 'aria-label': 'Hide' }, on: { click: () => (panel.hidden = true) } }, icon('close', 14)),
        ),
        list,
    );
    const add = (text: string, level: 'error' | 'warn') => {
        list.append(h('div', { class: `player-issue ${level}`, text }));
        while (list.childElementCount > 20) list.firstElementChild?.remove();
        list.scrollTop = list.scrollHeight;
        panel.hidden = false;
    };
    if (paused) add('Scripts are paused in the editor, so this preview runs without them. Enable them in the editor to run them here.', 'warn');
    player.on('issue', (i: ScriptIssue) => {
        const where = `${i.scriptName}${i.line ? ':' + i.line : ''}`;
        add(`[${where}] ${i.method}() on "${i.node}": ${i.message}`, 'error');
    });
    root.append(panel);
}

function fail(root: HTMLElement, title: string, reason: string, webgpuHints = false) {
    root.replaceChildren(
        h(
            'div',
            { class: 'player-message' },
            h('h1', { text: title }),
            h('p', { class: 'reason', text: reason }),
            webgpuHints
                ? h(
                      'ul',
                      null,
                      h('li', { text: 'Use a recent Chrome or Edge (113+) on Windows, macOS, ChromeOS or Android.' }),
                      h('li', { text: 'Safari 26+ and Firefox 141+ (Windows) also ship WebGPU.' }),
                      h('li', { text: 'Make sure hardware acceleration is enabled in the browser settings.' }),
                  )
                : null,
        ),
    );
}

void main();
