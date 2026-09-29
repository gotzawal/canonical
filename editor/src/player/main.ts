// Standalone game player. It runs a scene built with File > Build & Deploy
// (game.json next to the page), or with ?preview the scene the editor hands
// over through localStorage. It is the editor's engine layer and Play mode
// without the editor UI, so a game plays the way it does in the editor.

import './player.css';
import { GAME_FILE, PREVIEW_KEY, type GameFile, type PreviewData } from '../build/gameFile';
import { setAssetResolver } from '../core/assets';
import { sceneModelsNeeded } from '../core/behavior/format';
import { Store } from '../core/store';
import type { CameraState, SceneDoc } from '../core/types';
import { Picker } from '../engine/picking';
import { RenderGraphController } from '../engine/renderGraph';
import { Runtime } from '../engine/runtime';
import { probeDevice } from '../engine/device';
import { isQualityLevel, pickQuality, QUALITY, resolveQuality } from '../core/quality';
import { ShaderManager } from '../engine/shaders';
import { SceneSync, type TextureSource } from '../engine/sync';
import { storedCopy } from '../core/derived';
import { ScriptCompiler } from '../play/compiler';
import type { ModelServices } from '../play/ai/services';
import { loadPhysics, usesPhysics } from '../play/physics';
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
    /** Where the compressed copies of textures come from. */
    textures: TextureSource | null;
}

async function loadGame(): Promise<Game> {
    const params = new URLSearchParams(location.search);
    if (params.has('preview')) {
        let data: PreviewData | null = null;
        try {
            data = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null');
        } catch { /* reported below */ }
        if (!data?.scene) throw new Error('There is nothing to preview. Start a preview from the editor with File > Build & Deploy > Run.');
        // Assets come from this browser's IndexedDB, which the editor shares, with the compressed copies it made.
        return { title: data.title, doc: data.scene, camera: data.camera, trusted: data.trusted !== false, preview: true, textures: { resolve: storedCopy } };
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
    if (game?.format !== 'canonical-game' || !game.scene) throw new Error(`${GAME_FILE} is not a Morglay game.`);
    const files = game.files ?? {};
    setAssetResolver((meta) => (files[meta.id] ? new URL(files[meta.id], url).href : null));
    // Compressed copies of textures, by asset and role (the originals may not ship at all).
    const derived = game.derived ?? {};
    const textures: TextureSource = {
        async resolve(meta, role) {
            const path = derived[`${meta.id}|${role}`];
            if (!path) return null;
            const r = await fetch(new URL(path, url));
            return r.ok ? r.blob() : null;
        },
    };
    return { title: game.title, doc: game.scene, camera: game.camera, trusted: true, preview: false, textures };
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
    const name = game.title || game.doc.name || 'Morglay Game';
    document.title = game.preview ? `${name} (Preview)` : name;
    title.textContent = name;
    status.textContent = 'Starting WebGPU...';

    const store = new Store(game.doc);
    if (game.camera) store.camera = { ...store.camera, ...game.camera };
    // The graphics quality this device gets (?quality=low|medium|high overrides it): shadow maps are sized as the engine starts.
    const params = new URLSearchParams(location.search);
    const asked = params.get('quality');
    const override = isQualityLevel(asked) ? asked : null;
    const quality = resolveQuality(store.doc.environment.quality, pickQuality(await probeDevice()), override);

    let runtime: Runtime;
    try {
        // Draw calls and GPU memory are counted only when asked for (?stats): the counting costs a little on every call.
        runtime = await Runtime.create(canvas, { stats: params.has('stats'), quality });
    } catch (e: any) {
        console.error(e);
        fail(root, 'WebGPU is required', e?.message || String(e), true);
        return;
    }
    runtime.setGridVisible(false);
    runtime.setQualityOverride(override);
    // As fast as the display refreshes, at the tier's resolution.
    runtime.setViewport(0, QUALITY[quality].resolution);
    const shaders = new ShaderManager(runtime, store);
    const sync = new SceneSync(runtime, store, shaders, game.textures);
    const picker = new Picker(runtime, sync, store);
    // The view the game was built from, for scenes without a camera node.
    const view = new CameraController(runtime, store, picker);
    const compiler = new ScriptCompiler(store, game.trusted);
    // The player controller's joystick and hints go over the game; the agents get their models once they load.
    let agentModels: ModelServices | null = null;
    const player = new Player(runtime, store, sync, picker, compiler, { controls: root, aiServices: () => agentModels });
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
    // Agents that ask or recall get their models in the background; they
    // play with the blackboard defaults until the models are ready.
    if (sceneModelsNeeded(store.doc).length) agentModels = await startModels(root, runtime, player, store);
    // Bodies fall from the first frame (the player started loading Rapier with the scene).
    if (usesPhysics(store.doc)) await loadPhysics();
    player.play();
    bindInput(canvas, player, view);
    addFullscreenButton(root);
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 400);
    canvas.focus({ preventScroll: true });
    (window as any).__player = { runtime, store, sync, player, quality };
}

/**
 * The models of the scene's agents: ONNX Runtime and the inference worker
 * load only here, and the models download into the browser's cache on
 * first play (with Save-Data on, a button offers the download instead). A
 * chip in the corner shows the progress.
 */
async function startModels(root: HTMLElement, runtime: Runtime, player: Player, store: Store): Promise<ModelServices | null> {
    let services: typeof import('../play/ai/services');
    try {
        services = await import('../play/ai/services');
    } catch (e) {
        console.warn('[ai] the model services could not be loaded; the agents use their defaults', e);
        return null;
    }
    const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    const models = new services.ModelServices(runtime, player.speech, () => store.doc.aiModels, { policy: saveData ? 'ask' : 'auto' });
    const chip = h('button', { class: 'player-models', attrs: { type: 'button', hidden: true } });
    chip.addEventListener('click', () => {
        for (const id of Array.from(models.needed)) void models.download(id);
    });
    const ids = sceneModelsNeeded(store.doc);
    const update = () => {
        const busy = ids.map((id) => ({ id, s: models.status(id) })).find((x) => x.s.state === 'downloading' || x.s.state === 'loading');
        if (busy) {
            const pct = busy.s.total ? Math.min(100, Math.round(((busy.s.loaded ?? 0) / busy.s.total) * 100)) : 0;
            chip.textContent = busy.s.state === 'downloading' ? `AI model ${pct}%` : 'Starting AI...';
            chip.title = `${models.model(busy.id)?.name ?? busy.id}. The characters use their default behavior until it is ready.`;
            chip.disabled = true;
            chip.hidden = false;
            return;
        }
        if (models.needed.size) {
            const size = Array.from(models.needed).reduce((n, id) => {
                const m = models.model(id);
                return n + (m && 'size' in m ? m.size : 0);
            }, 0);
            chip.textContent = size ? `Download AI (${Math.round(size / 1e6)} MB)` : 'Download AI';
            chip.title = 'The characters use their default behavior without it. It is downloaded once into this browser.';
            chip.disabled = false;
            chip.hidden = false;
            return;
        }
        chip.hidden = true;
    };
    models.on('status', update);
    models.on('needed', update);
    root.append(chip);
    (window as any).__models = models;
    return models;
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
 * Keys go to the scripts; the left button, fingers (and every button when
 * the game has a camera of its own) too. Without one the right button
 * orbits the view, the middle button (or Shift + right) pans and the wheel
 * zooms. With a player controller, fingers move and look (play/playControls.ts).
 */
function bindInput(el: HTMLElement, player: Player, view: CameraController) {
    const local = (e: { clientX: number; clientY: number }): [number, number] => {
        const r = el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    };
    /** Pointers pressed for the game (several fingers at once). */
    const game = new Set<number>();
    /** The pointer moving the view, without a camera of the game's own. */
    let drag: { mode: 'orbit' | 'pan'; id: number; x: number; y: number } | null = null;

    el.addEventListener('pointerdown', (e) => {
        el.focus({ preventScroll: true });
        const [x, y] = local(e);
        const touch = e.pointerType !== 'mouse';
        if (e.button === 0 || player.usesGameCamera || touch) {
            el.setPointerCapture(e.pointerId);
            game.add(e.pointerId);
            player.pointerEvent('down', x, y, e.button, e.pointerId, touch);
        } else if (!drag) {
            el.setPointerCapture(e.pointerId);
            drag = { mode: e.button === 2 && !e.shiftKey ? 'orbit' : 'pan', id: e.pointerId, x, y };
        }
    });
    el.addEventListener('pointermove', (e) => {
        const [x, y] = local(e);
        if (drag?.id !== e.pointerId) {
            player.pointerEvent('move', x, y, e.button, e.pointerId, e.pointerType !== 'mouse');
            return;
        }
        if (drag.mode === 'orbit') view.orbit(x - drag.x, y - drag.y);
        else view.pan(drag.x, drag.y, x, y);
        drag.x = x;
        drag.y = y;
    });
    const up = (e: PointerEvent) => {
        const [x, y] = local(e);
        if (game.delete(e.pointerId)) player.pointerEvent(e.type === 'pointercancel' ? 'cancel' : 'up', x, y, e.button, e.pointerId, e.pointerType !== 'mouse');
        else if (drag?.id === e.pointerId) drag = null;
        else return;
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
