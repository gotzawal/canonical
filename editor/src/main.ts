import './styles.css';
import { newScene } from './core/defaults';
import { AutoSaver, readAutosave } from './core/persistence';
import { Store } from './core/store';
import { Editor } from './editor';
import { Picker } from './engine/picking';
import { RenderGraphController } from './engine/renderGraph';
import { Runtime } from './engine/runtime';
import { ShaderManager } from './engine/shaders';
import { SceneSync } from './engine/sync';
import { Checkpoints } from './design/checkpoints';
import { designSummary, memoLines, pipelineSummary } from './design/context';
import { createMenu, menuDefinitions, showShortcuts } from './menus';
import { ScriptCompiler } from './play/compiler';
import { Player } from './play/player';
import { AIPanel } from './ui/aiPanel';
import { AssetsPanel } from './ui/assetsPanel';
import { BriefScreen } from './ui/briefScreen';
import { DesignPanel } from './ui/designPanel';
import { PipelineBar } from './ui/pipelineBar';
import { ShotView } from './ui/shotView';
import { showBuildDialog } from './ui/buildDialog';
import { Dock } from './ui/dock';
import { h, isTyping } from './ui/dom';
import { HierarchyPanel } from './ui/hierarchy';
import { icon, nodeIcon } from './ui/icons';
import { InspectorPanel } from './ui/inspector';
import { logo } from './ui/logo';
import { closeMenus, menubar, showMenu, toast } from './ui/overlays';
import { ScenePanel } from './ui/scenePanel';
import { NOTICE_KINDS, notices } from './ui/notify';
import { captureConsole, onLogLocation, statusbar } from './ui/statusbar';
import { toolbar } from './ui/toolbar';
import { button } from './ui/widgets';
import { CameraController } from './viewport/cameraController';
import { WalkController } from './viewport/walk';
import { pipelineOverlay } from './ui/pipelineOverlay';
import { Gizmo } from './viewport/gizmo';
import { Viewport } from './viewport/viewport';

const LAYOUT_KEY = 'canonical-editor/layout';

type RightTab = 'inspector' | 'scene' | 'design' | 'ai';

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
    const dockSlot = h('div', { class: 'dock-slot' });
    const left = h('aside', { class: 'side left' });
    const right = h('aside', { class: 'side right' });
    const menuSlot = h('div', { class: 'menu-slot' });
    const pipelineSlot = h('div', { class: 'pipeline-slot' });
    const sceneName = h('span', { class: 'scene-name' });
    const statusSlot = h('div', { class: 'status-slot' });
    const bell = h('button', { class: 'icon-btn', title: 'Notifications', attrs: { type: 'button', 'aria-label': 'Notification settings' } }, icon('bell', 16));
    const leftToggle = h('button', { class: 'icon-btn panel-toggle', title: 'Hierarchy', attrs: { type: 'button', 'aria-label': 'Toggle hierarchy' } }, icon('layers', 16));
    const rightToggle = h('button', { class: 'icon-btn panel-toggle', title: 'Inspector', attrs: { type: 'button', 'aria-label': 'Toggle inspector' } }, icon('sliders', 16));

    app.append(
        h(
            'header',
            { class: 'topbar' },
            h('div', { class: 'brand' }, logo(20, 'brand-mark'), h('span', { class: 'brand-name', text: 'Canonical' }), h('span', { class: 'brand-sub', text: 'Editor' })),
            menuSlot,
            h('div', { class: 'spacer' }),
            sceneName,
            h('div', { class: 'spacer' }),
            bell,
            leftToggle,
            rightToggle,
        ),
        pipelineSlot,
        h(
            'main',
            { class: 'workspace' },
            left,
            h('div', { class: 'splitter', dataset: { side: 'left' } }),
            h('section', { class: 'center' }, toolbarSlot, viewportEl, h('div', { class: 'splitter horizontal dock-splitter', dataset: { side: 'dock' } }), dockSlot),
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

    const shaders = new ShaderManager(runtime, store);
    const sync = new SceneSync(runtime, store, shaders);
    const picker = new Picker(runtime, sync, store);
    const camera = new CameraController(runtime, store, picker);
    const gizmo = new Gizmo(store, picker);
    const autosave = new AutoSaver(store);
    const compiler = new ScriptCompiler(store, !saved?.scriptsPaused);
    autosave.scriptsPaused = !compiler.trusted;
    compiler.on('trust', (trusted) => {
        autosave.scriptsPaused = !trusted;
        autosave.schedule();
    });
    const player = new Player(runtime, store, sync, picker, compiler);
    const graph = new RenderGraphController(runtime, store, shaders, sync);
    const editor = new Editor(store, runtime, sync, picker, camera, autosave, { shaders, compiler, player, graph });
    const overlayDrawers: ((ctx: CanvasRenderingContext2D) => void)[] = [];
    gizmo.guard = (ids) => editor.pipeline.canPlace(ids);
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
                          { label: 'Ask AI about this', icon: 'sparkle', action: () => editor.askAI('For the selected object: ') },
                          { label: 'Add', icon: 'plus', submenu: createMenu(editor) },
                      ]
                    : createMenu(editor),
                cx,
                cy,
            );
        },
        onDropFiles: (files, point) => void editor.importFiles(files, point),
        onDropAsset: (ref, point, hitId) => {
            const target = hitId ? [hitId] : store.selection;
            if (ref.startsWith('script:')) {
                const id = ref.slice(7);
                if (!target.length) toast('Drop the script onto an object.', 'info');
                else {
                    editor.attachScript(target, id);
                    store.select(target);
                }
                return;
            }
            if (ref.startsWith('shader:')) {
                const s = store.doc.shaders.find((x) => x.id === ref.slice(7));
                if (!s) return;
                if (s.kind === 'post') editor.addPostEffect(s.id);
                else editor.assignShader(target, s.id);
                return;
            }
            if (ref.startsWith('prefab:')) {
                editor.placePrefab(ref.slice(7), point);
                return;
            }
            const asset = store.doc.assets.find((a) => a.id === ref);
            if (asset?.kind === 'model') editor.addModel(ref, point);
            else if (asset) editor.applyTexture(ref, hitId && store.node(hitId)?.mesh ? [hitId] : store.selection);
        },
        onPickPart: (id, renderer) => {
            const path = renderer ? sync.modelInfo(id)?.pathOf(renderer) ?? null : null;
            editor.focusPart(id, path);
        },
        focusedPart: () => {
            const f = editor.focusedPart;
            if (!f || !store.selection.includes(f.node)) return null;
            const part = sync.modelInfo(f.node)?.part(f.path);
            return part ? { node: f.node, renderer: part.renderer } : null;
        },
        selectable: (id) => editor.selectable(id),
        captured: () => !!editor.walk?.active,
        drawExtra: (ctx) => overlayDrawers.forEach((fn) => fn(ctx)),
        play: {
            active: () => player.state !== 'stopped',
            gameCamera: () => player.usesGameCamera,
            pointer: (type, x, y, button) => player.pointerEvent(type, x, y, button),
            wheel: (d) => player.wheelEvent(d),
        },
    });
    editor.viewport = viewport;
    editor.walk = new WalkController(editor, viewport.overlay, viewportEl);
    overlayDrawers.push(pipelineOverlay(editor));

    store.on('change', (hint) => sync.sync(hint));
    store.on('prefs', (p) => runtime.setGridVisible(p.grid && !store.playing));
    sync.sync();
    runtime.setGridVisible(store.prefs.grid);
    store.on('selection', (sel) => {
        if (editor.focusedPart && !sel.includes(editor.focusedPart.node)) editor.focusedPart = null;
    });

    // ------------------------------------------------------------- panels
    const hierarchy = new HierarchyPanel(editor, () => createMenu(editor));
    const assets = new AssetsPanel(editor);
    left.append(hierarchy.el, h('div', { class: 'splitter horizontal', dataset: { side: 'assets' } }), assets.el);
    installSplitters(app);

    const dock = new Dock(editor, app);
    dockSlot.append(dock.el);
    editor.applyCodeEdits = () => {
        const dirty = dock.dirtyPanels();
        for (const p of dirty) p.apply();
        return dirty.length;
    };
    editor.beforePlay = () => {
        const applied = editor.applyCodeEdits();
        if (applied) toast(`Applied ${applied} edited file(s) before playing.`, 'info');
    };

    // Scripts of an opened file stay paused until the user enables them.
    const scriptNotice = h('div', { class: 'viewport-notice', attrs: { role: 'status', hidden: true } });
    viewportEl.append(scriptNotice);
    let noticeKey = '';
    const updateNotice = () => {
        const count = store.doc.scripts.length;
        const key = !compiler.trusted && count > 0 ? String(count) : '';
        if (key === noticeKey) return;
        noticeKey = key;
        scriptNotice.hidden = !key;
        if (!key) return;
        const one = count === 1;
        scriptNotice.replaceChildren(
            icon('alert', 15),
            h('span', { text: `${count} script${one ? '' : 's'} from the opened file ${one ? 'is' : 'are'} paused. Scripts run JavaScript in this page: read ${one ? 'it' : 'them'} first.` }),
            button('Review', () => {
                const first = store.doc.scripts[0];
                if (first) dock.open('script', first.id);
            }, 'small'),
            button('Enable Scripts', () => editor.enableScripts(), 'small primary'),
        );
    };
    compiler.on('trust', updateNotice);
    store.on('load', updateNotice);
    store.on('change', updateNotice);
    updateNotice();

    const tabs = h('div', { class: 'tabs', attrs: { role: 'tablist' } });
    const inspectorTab = h('button', { class: 'tab active', text: 'Inspector', attrs: { type: 'button', role: 'tab' } });
    const sceneTab = h('button', { class: 'tab', text: 'Scene', attrs: { type: 'button', role: 'tab' } });
    const designTab = h('button', { class: 'tab', attrs: { type: 'button', role: 'tab' } }, icon('flag', 13), h('span', { text: 'Design' }));
    const aiTab = h('button', { class: 'tab', attrs: { type: 'button', role: 'tab' } }, icon('sparkle', 13), h('span', { text: 'AI' }));
    tabs.append(inspectorTab, sceneTab, designTab, aiTab);
    const scenePanel = new ScenePanel(editor);
    const inspector = new InspectorPanel(editor, () => showTab('scene'));
    const aiPanel = new AIPanel(editor, () => aiContext(editor, dock));
    const brief = new BriefScreen(editor, () => designPanel.structure());
    viewportEl.append(brief.el);
    const designPanel = new DesignPanel(editor, {
        showBrief: () => brief.open(),
        ask: (text, images) => {
            showTab('ai');
            aiPanel.send(text, images);
        },
    });
    new ShotView(editor, viewportEl);
    const showTab = (tab: RightTab) => {
        inspectorTab.classList.toggle('active', tab === 'inspector');
        sceneTab.classList.toggle('active', tab === 'scene');
        designTab.classList.toggle('active', tab === 'design');
        aiTab.classList.toggle('active', tab === 'ai');
        inspector.el.hidden = tab !== 'inspector';
        scenePanel.el.hidden = tab !== 'scene';
        designPanel.el.hidden = tab !== 'design';
        aiPanel.el.hidden = tab !== 'ai';
        if (tab === 'ai' || tab === 'design') {
            app.classList.remove('hide-right');
            if (isNarrow()) app.classList.add('show-right');
        }
        if (tab === 'ai') aiPanel.focus();
        if (tab === 'design') designPanel.shown();
    };
    inspectorTab.addEventListener('click', () => showTab('inspector'));
    sceneTab.addEventListener('click', () => showTab('scene'));
    designTab.addEventListener('click', () => showTab('design'));
    aiTab.addEventListener('click', () => showTab('ai'));
    store.on('selection', (sel) => {
        if (sel.length && aiPanel.el.hidden && designPanel.el.hidden) showTab('inspector');
    });
    editor.on('ai-prompt', () => showTab('ai'));
    editor.on('show-design', () => showTab('design'));
    editor.on('show-scene', () => {
        showTab('scene');
        app.classList.remove('hide-right');
        if (isNarrow()) app.classList.add('show-right');
    });
    editor.on('show-brief', () => brief.open());
    showTab('inspector');
    pipelineSlot.append(new PipelineBar(editor, { design: () => showTab('design'), brief: () => brief.open() }).el);

    // Page notifications: the assistant finished, save checkpoints.
    const checkpoints = new Checkpoints(editor, aiPanel.agent);
    editor.checkpoints = checkpoints;
    aiPanel.agent.on('done', (d) => {
        const first = d.answer.replace(/[#*`>]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
        notices.show({
            kind: 'ai-done',
            key: 'ai-done',
            icon: d.error ? 'alert' : 'sparkle',
            title: d.error ? 'The assistant ran into an error' : d.stopped ? 'The assistant stopped' : 'The assistant finished',
            body: d.error ? d.error.slice(0, 200) : first.length > 180 ? first.slice(0, 177) + '...' : first,
            timeout: d.error ? 0 : 9000,
            actions: [{ label: 'Show', run: () => showTab('ai') }],
        });
    });
    bell.addEventListener('click', () => {
        const r = bell.getBoundingClientRect();
        showMenu(
            [
                ...NOTICE_KINDS.map((k) => ({
                    label: k.label,
                    checked: () => notices.enabled(k.kind),
                    action: () => notices.setEnabled(k.kind, !notices.enabled(k.kind)),
                })),
                { separator: true },
                {
                    label: 'Also as system notifications in the background',
                    checked: () => notices.prefs.system,
                    enabled: () => notices.systemSupported,
                    action: () => void notices.setSystem(!notices.prefs.system),
                },
            ],
            Math.max(8, r.right - 300),
            r.bottom + 4,
        );
    });
    right.append(tabs, inspector.el, scenePanel.el, designPanel.el, aiPanel.el);

    onLogLocation((file, line) => {
        const script = store.doc.scripts.find((s) => s.name === file);
        if (script) dock.open('script', script.id)?.reveal(line);
        const shader = store.doc.shaders.find((s) => s.name === file);
        if (shader) dock.open('shader', shader.id)?.reveal(line);
    });

    const rename = () => {
        const id = store.primary?.id;
        if (id) hierarchy.startRename(id);
    };
    menuSlot.append(
        menubar(
            menuDefinitions(editor, {
                rename,
                toggleLeft: () => void toggle(isNarrow() ? 'show-left' : 'hide-left'),
                toggleRight: () => void toggle(isNarrow() ? 'show-right' : 'hide-right'),
                toggleDock: () => dock.toggle(),
                showGraph: () => dock.show('graph'),
                showAI: () => showTab('ai'),
            }),
        ),
    );
    toolbarSlot.append(
        toolbar(editor, () => createMenu(editor), {
            toggleDock: () => dock.toggle(),
            showAI: () => showTab('ai'),
            build: () => showBuildDialog(editor),
            walk: () => editor.walk?.toggle(),
        }),
    );
    statusSlot.append(statusbar(editor));

    const updateTitle = () => {
        sceneName.textContent = store.doc.name;
        document.title = `${store.doc.name} - Canonical Editor`;
    };
    store.on('change', updateTitle);
    store.on('load', updateTitle);
    updateTitle();

    store.on('playing', (playing) => {
        app.classList.toggle('playing', playing);
        // The game view has no editor grid.
        runtime.setGridVisible(!playing && store.prefs.grid);
    });
    // GI probe spheres are an editor view aid: hidden while playing.
    const updateProbeHelpers = () => runtime.gi.setHelpersVisible(store.prefs.giProbes && !store.playing);
    store.on('prefs', updateProbeHelpers);
    store.on('playing', updateProbeHelpers);
    updateProbeHelpers();
    player.on('state', (st) => app.classList.toggle('paused', st === 'paused'));

    installShortcuts(editor, rename, dock);
    autosave.schedule();
    if (!saved) toast('Welcome! Drop a .glb model onto the viewport, use Add to build a scene, or ask the AI assistant.', 'info', 6000);

    (window as any).__editor = editor;
}

/** What the assistant is told about the editor with every message. */
function aiContext(editor: Editor, dock: Dock): string {
    const store = editor.store;
    const lines: string[] = [];
    const sel = store.selection.map((id) => store.node(id)).filter(Boolean).slice(0, 12);
    lines.push(sel.length ? `Selected: ${sel.map((n) => `${n!.name} (id ${n!.id}, ${nodeIcon(n!) === 'empty' ? 'empty' : nodeIcon(n!)})`).join(', ')}` : 'Selected: nothing');
    const doc = dock.activeDoc();
    if (doc) lines.push(`Open in the code editor: ${doc.name} (${doc.kind} id ${doc.id})`);
    const f = editor.focusedPart;
    if (f) lines.push(`Picked model mesh: ${f.path} of ${store.node(f.node)?.name ?? f.node}`);
    lines.push(`Scene "${store.doc.name}": ${store.doc.nodes.length} objects, ${store.doc.prefabs.length} prefabs, ${store.doc.scripts.length} scripts, ${store.doc.shaders.length} shaders. Play mode: ${editor.player.state}.`);
    if (!editor.compiler.trusted && store.doc.scripts.length) lines.push('Scripts are paused: the scene was opened from a file and the user has not enabled its scripts yet.');
    lines.push(...pipelineSummary(store.doc, editor.runtime.fps), ...designSummary(store.doc), ...memoLines(store.doc));
    return lines.join('\n');
}

function installShortcuts(editor: Editor, rename: () => void, dock: Dock) {
    const store = editor.store;
    const player = editor.player;
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && key === 'p') {
            e.preventDefault();
            if (e.shiftKey) editor.pausePlay();
            else editor.togglePlay();
            return;
        }
        if (mod && (key === 'j' || key === '`')) {
            e.preventDefault();
            dock.toggle();
            return;
        }
        // While playing, keys pressed with the viewport focused belong to the scripts.
        if (player.state !== 'stopped' && !isTyping(e.target) && (e.target === editor.viewport.overlay || e.target === document.body)) {
            player.keyEvent(e, true);
            if (!mod) {
                e.preventDefault();
                return;
            }
        }
        if (isTyping(e.target)) {
            // Save / open still work from text fields; everything else types.
            if (mod && (key === 's' || key === 'o')) {
                e.preventDefault();
                (e.target as HTMLElement).blur();
                if (key === 's') void (e.shiftKey ? editor.saveProjectFile() : editor.saveSceneFile());
                else void editor.openSceneFile();
            }
            return;
        }
        let handled = true;
        if (mod && key === 'z') e.shiftKey ? store.redo() : store.undo();
        else if (mod && key === 'y') store.redo();
        else if (mod && key === 's') void (e.shiftKey ? editor.saveProjectFile() : editor.saveSceneFile());
        else if (mod && key === 'o') void editor.openSceneFile();
        else if (mod && key === 'b') showBuildDialog(editor);
        else if (mod && key === 'd') editor.duplicateSelection();
        else if (mod && key === 'a') editor.selectAll();
        else if (mod && key === 'g') editor.groupSelection();
        else if (mod || e.altKey) handled = false;
        else if (key === 'q') editor.setTool('select');
        else if (key === 'w') editor.setTool('translate');
        else if (key === 'e') editor.setTool('rotate');
        else if (key === 'r') editor.setTool('scale');
        else if (key === 'x') editor.toggleSpace();
        else if (key === 'v') editor.walk?.toggle();
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
    document.addEventListener('keyup', (e) => {
        if (player.state !== 'stopped') player.keyEvent(e, false);
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
    for (const k of ['--left-w', '--right-w', '--assets-h', '--dock-h']) {
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
                else if (side === 'right') app.style.setProperty('--right-w', clampPx(window.innerWidth - ev.clientX, 240, window.innerWidth * 0.5));
                else if (side === 'assets') {
                    const panel = sp.parentElement!.getBoundingClientRect();
                    app.style.setProperty('--assets-h', clampPx(panel.bottom - ev.clientY, 60, panel.height - 120));
                } else if (side === 'dock') {
                    const center = sp.parentElement!.getBoundingClientRect();
                    app.style.setProperty('--dock-h', clampPx(center.bottom - ev.clientY, 120, center.height - 140));
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
            h('div', { class: 'brand' }, logo(20, 'brand-mark'), h('span', { class: 'brand-name', text: 'Canonical' }), h('span', { class: 'brand-sub', text: 'Editor' })),
            h('h1', { text: 'WebGPU is required' }),
            h('p', { text: 'The editor renders with the Orillusion WebGPU engine, which could not start in this browser.' }),
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
