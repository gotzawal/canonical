import './styles.css';
import { newScene } from './core/defaults';
import { AutoSaver, readAutosave } from './core/persistence';
import { Store } from './core/store';
import { Editor } from './editor';
import { Picker } from './engine/picking';
import { Runtime } from './engine/runtime';
import { SceneSync } from './engine/sync';
import { createMenu, menuDefinitions, showShortcuts } from './menus';
import { AssetsPanel } from './ui/assetsPanel';
import { h, isTyping } from './ui/dom';
import { HierarchyPanel } from './ui/hierarchy';
import { icon } from './ui/icons';
import { InspectorPanel } from './ui/inspector';
import { closeMenus, menubar, showMenu, toast } from './ui/overlays';
import { ScenePanel } from './ui/scenePanel';
import { captureConsole, statusbar } from './ui/statusbar';
import { toolbar } from './ui/toolbar';
import { CameraController } from './viewport/cameraController';
import { Gizmo } from './viewport/gizmo';
import { Viewport } from './viewport/viewport';

const LAYOUT_KEY = 'canonical-editor/layout';

async function main() {
    captureConsole();
    const app = document.getElementById('app')!;

    if (!('gpu' in navigator)) {
        unsupported(app, 'This browser does not expose WebGPU.');
        return;
    }

    const saved = readAutosave();
    const store = new Store(saved?.doc ?? newScene());
    if (saved?.camera) store.camera = { ...store.camera, ...saved.camera };

    // ------------------------------------------------------------ shell
    const canvas = h('canvas', { class: 'gpu', style: 'width:100%;height:100%' });
    const loading = h('div', { class: 'viewport-loading' }, h('div', { class: 'spinner' }), h('span', { text: 'Starting WebGPU engine...' }));
    const viewportEl = h('div', { class: 'viewport' }, canvas, loading);
    const toolbarSlot = h('div', { class: 'toolbar-slot' });
    const left = h('aside', { class: 'side left' });
    const right = h('aside', { class: 'side right' });
    const menuSlot = h('div', { class: 'menu-slot' });
    const sceneName = h('span', { class: 'scene-name' });
    const statusSlot = h('div', { class: 'status-slot' });
    const leftToggle = h('button', { class: 'icon-btn panel-toggle', title: 'Hierarchy', attrs: { type: 'button', 'aria-label': 'Toggle hierarchy' } }, icon('layers', 16));
    const rightToggle = h('button', { class: 'icon-btn panel-toggle', title: 'Inspector', attrs: { type: 'button', 'aria-label': 'Toggle inspector' } }, icon('sliders', 16));

    app.append(
        h(
            'header',
            { class: 'topbar' },
            h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), h('span', { class: 'brand-name', text: 'Canonical' }), h('span', { class: 'brand-sub', text: 'Editor' })),
            menuSlot,
            h('div', { class: 'spacer' }),
            sceneName,
            h('div', { class: 'spacer' }),
            leftToggle,
            rightToggle,
        ),
        h(
            'main',
            { class: 'workspace' },
            left,
            h('div', { class: 'splitter', dataset: { side: 'left' } }),
            h('section', { class: 'center' }, toolbarSlot, viewportEl),
            h('div', { class: 'splitter', dataset: { side: 'right' } }),
            right,
        ),
        statusSlot,
    );
    restoreLayout(app);
    installSplitters(app);
    const toggle = (cls: string) => app.classList.toggle(cls);
    leftToggle.addEventListener('click', () => toggle(isNarrow() ? 'show-left' : 'hide-left'));
    rightToggle.addEventListener('click', () => toggle(isNarrow() ? 'show-right' : 'hide-right'));

    // ----------------------------------------------------------- engine
    let runtime: Runtime;
    try {
        runtime = await Runtime.create(canvas);
    } catch (e: any) {
        console.error(e);
        unsupported(app, e?.message || String(e));
        return;
    }
    loading.remove();

    const sync = new SceneSync(runtime, store);
    const picker = new Picker(runtime, sync, store);
    const camera = new CameraController(runtime, store, picker);
    const gizmo = new Gizmo(store, picker);
    const autosave = new AutoSaver(store);
    const editor = new Editor(store, runtime, sync, picker, camera, autosave);
    const viewport = new Viewport(viewportEl, runtime, store, sync, picker, camera, gizmo, {
        onContextMenu: (_x, _y, cx, cy, id) => {
            showMenu(
                id
                    ? [
                          { label: 'Frame', icon: 'focus', shortcut: 'F', action: () => editor.frameSelection() },
                          { label: 'Duplicate', icon: 'copy', shortcut: 'Mod+D', action: () => editor.duplicateSelection() },
                          { label: 'Delete', icon: 'trash', shortcut: 'Del', action: () => editor.deleteSelection() },
                          { label: 'Hide', icon: 'eyeOff', shortcut: 'H', action: () => editor.toggleVisibility(store.selection) },
                          { label: 'Drop to Ground', action: () => editor.dropToGround() },
                          { separator: true },
                          { label: 'Add', icon: 'plus', submenu: createMenu(editor) },
                      ]
                    : createMenu(editor),
                cx,
                cy,
            );
        },
        onDropFiles: (files, point) => void editor.importFiles(files, point),
        onDropAsset: (assetId, point, hitId) => {
            const asset = store.doc.assets.find((a) => a.id === assetId);
            if (asset?.kind === 'model') editor.addModel(assetId, point);
            else if (asset) editor.applyTexture(assetId, hitId && store.node(hitId)?.mesh ? [hitId] : store.selection);
        },
    });
    editor.viewport = viewport;

    store.on('change', (hint) => sync.sync(hint));
    store.on('prefs', (p) => runtime.setGridVisible(p.grid));
    sync.sync();
    runtime.setGridVisible(store.prefs.grid);

    // ------------------------------------------------------------- panels
    const hierarchy = new HierarchyPanel(editor, () => createMenu(editor));
    const assets = new AssetsPanel(editor);
    left.append(hierarchy.el, h('div', { class: 'splitter horizontal', dataset: { side: 'assets' } }), assets.el);
    installSplitters(app);

    const tabs = h('div', { class: 'tabs', attrs: { role: 'tablist' } });
    const inspectorTab = h('button', { class: 'tab active', text: 'Inspector', attrs: { type: 'button', role: 'tab' } });
    const sceneTab = h('button', { class: 'tab', text: 'Scene', attrs: { type: 'button', role: 'tab' } });
    tabs.append(inspectorTab, sceneTab);
    const scenePanel = new ScenePanel(editor);
    const inspector = new InspectorPanel(editor, () => showTab('scene'));
    const showTab = (tab: 'inspector' | 'scene') => {
        inspectorTab.classList.toggle('active', tab === 'inspector');
        sceneTab.classList.toggle('active', tab === 'scene');
        inspector.el.hidden = tab !== 'inspector';
        scenePanel.el.hidden = tab !== 'scene';
    };
    inspectorTab.addEventListener('click', () => showTab('inspector'));
    sceneTab.addEventListener('click', () => showTab('scene'));
    store.on('selection', (sel) => {
        if (sel.length) showTab('inspector');
    });
    showTab('inspector');
    right.append(tabs, inspector.el, scenePanel.el);

    const rename = () => {
        const id = store.primary?.id;
        if (id) hierarchy.startRename(id);
    };
    menuSlot.append(
        menubar(
            menuDefinitions(editor, {
                rename,
                toggleLeft: () => toggle(isNarrow() ? 'show-left' : 'hide-left'),
                toggleRight: () => toggle(isNarrow() ? 'show-right' : 'hide-right'),
            }),
        ),
    );
    toolbarSlot.append(toolbar(editor, () => createMenu(editor)));
    statusSlot.append(statusbar(editor));

    const updateTitle = () => {
        sceneName.textContent = store.doc.name;
        document.title = `${store.doc.name} - Canonical Editor`;
    };
    store.on('change', updateTitle);
    store.on('load', updateTitle);
    updateTitle();

    installShortcuts(editor, rename);
    autosave.schedule();
    if (!saved) toast('Welcome! Drop a .glb model onto the viewport or use Add to build a scene.', 'info', 6000);

    (window as any).__editor = editor;
}

function installShortcuts(editor: Editor, rename: () => void) {
    const store = editor.store;
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (isTyping(e.target)) {
            // Save / open still work from text fields; everything else types.
            if (mod && (key === 's' || key === 'o')) {
                e.preventDefault();
                (e.target as HTMLElement).blur();
                if (key === 's') void editor.saveSceneFile();
                else void editor.openSceneFile();
            }
            return;
        }
        let handled = true;
        if (mod && key === 'z') e.shiftKey ? store.redo() : store.undo();
        else if (mod && key === 'y') store.redo();
        else if (mod && key === 's') void editor.saveSceneFile();
        else if (mod && key === 'o') void editor.openSceneFile();
        else if (mod && key === 'd') editor.duplicateSelection();
        else if (mod && key === 'a') editor.selectAll();
        else if (mod && key === 'g') editor.groupSelection();
        else if (mod || e.altKey) handled = false;
        else if (key === 'q') editor.setTool('select');
        else if (key === 'w') editor.setTool('translate');
        else if (key === 'e') editor.setTool('rotate');
        else if (key === 'r') editor.setTool('scale');
        else if (key === 'x') editor.toggleSpace();
        else if (key === 'f') editor.frameSelection();
        else if (key === 'home') editor.viewport.frameAll();
        else if (key === 'g') store.setPrefs({ grid: !store.prefs.grid });
        else if (key === 'h') editor.toggleVisibility(store.selection);
        else if (key === 'delete' || key === 'backspace') editor.deleteSelection();
        else if (key === 'f2') rename();
        else if (key === '?') showShortcuts();
        else if (e.code === 'Digit1' || e.code === 'Numpad1') editor.camera.setView(e.shiftKey ? 180 : 0, 0);
        else if (e.code === 'Digit3' || e.code === 'Numpad3') editor.camera.setView(e.shiftKey ? 270 : 90, 0);
        else if (e.code === 'Digit7' || e.code === 'Numpad7') editor.camera.setView(store.camera.yaw, e.shiftKey ? -89.5 : 89.5);
        else if (key === 'escape') {
            closeMenus();
            if (!editor.viewport.cancelInteraction()) store.select([]);
        } else handled = false;
        if (handled) e.preventDefault();
    });
}

function isNarrow() {
    return window.matchMedia('(max-width: 900px)').matches;
}

function restoreLayout(app: HTMLElement) {
    try {
        const layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
        for (const [k, v] of Object.entries(layout)) app.style.setProperty(k, String(v));
    } catch { /* ignore */ }
}

function saveLayout(app: HTMLElement) {
    const out: Record<string, string> = {};
    for (const k of ['--left-w', '--right-w', '--assets-h']) {
        const v = app.style.getPropertyValue(k);
        if (v) out[k] = v;
    }
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(out));
    } catch { /* ignore */ }
}

function installSplitters(app: HTMLElement) {
    app.querySelectorAll<HTMLElement>('.splitter:not([data-ready])').forEach((sp) => {
        sp.dataset.ready = '1';
        sp.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            sp.setPointerCapture(e.pointerId);
            sp.classList.add('active');
            const side = sp.dataset.side;
            const move = (ev: PointerEvent) => {
                if (side === 'left') app.style.setProperty('--left-w', clampPx(ev.clientX, 180, window.innerWidth * 0.4));
                else if (side === 'right') app.style.setProperty('--right-w', clampPx(window.innerWidth - ev.clientX, 240, window.innerWidth * 0.45));
                else if (side === 'assets') {
                    const panel = sp.parentElement!.getBoundingClientRect();
                    app.style.setProperty('--assets-h', clampPx(panel.bottom - ev.clientY, 60, panel.height - 120));
                }
            };
            const up = () => {
                sp.classList.remove('active');
                sp.removeEventListener('pointermove', move);
                sp.removeEventListener('pointerup', up);
                saveLayout(app);
            };
            sp.addEventListener('pointermove', move);
            sp.addEventListener('pointerup', up);
        });
    });
}

function clampPx(v: number, min: number, max: number): string {
    return Math.round(Math.max(min, Math.min(max, v))) + 'px';
}

function unsupported(app: HTMLElement, reason: string) {
    app.replaceChildren(
        h(
            'div',
            { class: 'unsupported' },
            h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), h('span', { class: 'brand-name', text: 'Canonical' }), h('span', { class: 'brand-sub', text: 'Editor' })),
            h('h1', { text: 'WebGPU is required' }),
            h('p', { text: 'The editor renders with the Canonical WebGPU engine, which could not start in this browser.' }),
            h('p', { class: 'reason', text: reason }),
            h(
                'ul',
                null,
                h('li', { text: 'Use a recent Chrome or Edge (113+) on Windows, macOS, ChromeOS or Android.' }),
                h('li', { text: 'Safari 26+ and Firefox 141+ (Windows) also ship WebGPU.' }),
                h('li', { text: 'On Linux, Chrome may need chrome://flags/#enable-unsafe-webgpu and Vulkan.' }),
                h('li', { text: 'Make sure hardware acceleration is enabled in the browser settings.' }),
            ),
        ),
    );
}

void main();
