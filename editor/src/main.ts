import './styles.css';
import { newScene } from './core/defaults';
import { readLocal, writeLocal } from './core/local';
import { captureConsole, logInfo } from './core/log';
import { messages } from './core/messages';
import { perfMonitorWanted, startPerfMonitor } from './core/perf';
import { AutoSaver, download, otherTabsOpen, readAutosave, registerTab, unreadableAutosave } from './core/persistence';
import { Store } from './core/store';
import { UNTITLED_SCENE } from './core/types';
import { Editor } from './editor';
import { Picker } from './engine/picking';
import { RenderGraphController } from './engine/renderGraph';
import { Runtime } from './engine/runtime';
import { ShaderManager } from './engine/shaders';
import { SceneSync } from './engine/sync';
import { Checkpoints } from './ai/checkpoints';
import { designSummary, memoLines, pipelineSummary } from './design/context';
import { Commands, editorCommands } from './commands';
import { createMenu, menuDefinitions } from './menus';
import { ScriptCompiler } from './play/compiler';
import { Player } from './play/player';
import { ModelServices, savedBackend } from './play/ai/services';
import { scriptChat } from './ai/scriptChat';
import { formatBytes } from './core/assets';
import { AIPanel } from './ui/aiPanel';
import { AIStatus } from './ui/aiStatus';
import { onChanges, touches } from './ui/batch';
import { AssetsPanel } from './ui/assetsPanel';
import { DesignPanel } from './ui/designPanel';
import { PipelineBar } from './ui/pipelineBar';
import { StartScreen } from './ui/startScreen';
import { StepsBar } from './ui/stepsBar';
import { openVersionHistory } from './ui/versionHistory';
import { draggedLibraryItem } from './ui/libraryDialog';
import { NavOverlay } from './viewport/navOverlay';
import { ShotView } from './ui/shotView';
import { Dock } from './ui/dock';
import { h } from './ui/dom';
import { HierarchyPanel } from './ui/hierarchy';
import { icon, nodeIcon } from './ui/icons';
import { InspectorPanel } from './ui/inspector';
import { logo, wordmark } from './ui/logo';
import { mascotPose } from './ui/mascot';
import { dialog, menubar, showMenu, toast, type MenuItem } from './ui/overlays';
import { ScenePanel } from './ui/scenePanel';
import { NOTICE_KINDS, notices } from './ui/notify';
import { statusbar } from './ui/statusbar';
import { applyTheme } from './ui/theme';
import { toolbar } from './ui/toolbar';
import { button } from './ui/widgets';
import { CameraController } from './viewport/cameraController';
import { TerrainBrush } from './viewport/terrainBrush';
import { WalkController } from './viewport/walk';
import { ReferenceRoom } from './viewport/referenceRoom';
import { pipelineOverlay } from './ui/pipelineOverlay';
import { Gizmo } from './viewport/gizmo';
import { Viewport } from './viewport/viewport';
import { DerivedAssets } from './derive/derivedAssets';
import encoderWasm from 'basis-encoder/wasm?url';

const LAYOUT_KEY = 'canonical-editor/layout';

type RightTab = 'inspector' | 'scene' | 'design' | 'ai';

async function main() {
    // Development builds time every listener and report long tasks (core/perf.ts).
    if (perfMonitorWanted()) startPerfMonitor();
    captureConsole();
    // Messages from below the UI (core/messages.ts).
    messages.on('toast', (m) => toast(m.text, m.kind, m.timeout));
    messages.on('notice', (n) => notices.show(n));
    messages.on('dismiss', (key) => notices.dismiss(key));
    messages.on('ask', (q) => void dialog(q.title, q.body, q.choices).then(q.answer));
    const app = document.getElementById('app')!;

    if (!('gpu' in navigator)) {
        unsupported(app, 'This browser does not expose WebGPU.');
        return;
    }

    registerTab();
    const saved = readAutosave();
    const store = new Store(saved?.doc ?? newScene());
    if (saved?.camera) store.camera = { ...store.camera, ...saved.camera };
    applyTheme(store.prefs);
    store.on('prefs', applyTheme);

    // ------------------------------------------------------------ shell
    const canvas = h('canvas', { class: 'gpu', style: 'width:100%;height:100%' });
    const loading = h(
        'div',
        { class: 'viewport-loading' },
        mascotPose('walk', 150),
        h('div', { class: 'viewport-loading-text' }, h('div', { class: 'spinner small' }), h('span', { text: 'Starting WebGPU engine...' })),
    );
    const viewportEl = h('div', { class: 'viewport' }, canvas, loading);
    const toolbarSlot = h('div', { class: 'toolbar-slot' });
    const dockSlot = h('div', { class: 'dock-slot' });
    const left = h('aside', { class: 'side left' });
    const right = h('aside', { class: 'side right' });
    const menuSlot = h('div', { class: 'menu-slot' });
    const pipelineSlot = h('div', { class: 'pipeline-slot' });
    // The simple view's steps sit beside the scene's name, not on a row of their own.
    const stepsSlot = h('div', { class: 'steps-slot' });
    const sceneName = sceneNameField(store);
    const statusSlot = h('div', { class: 'status-slot' });
    const bell = h('button', { class: 'icon-btn', title: 'Notifications', attrs: { type: 'button', 'aria-label': 'Notification settings' } }, icon('bell', 16));
    const modeToggle = h(
        'button',
        { class: 'mode-toggle', attrs: { type: 'button', 'aria-pressed': 'false' } },
        icon('panels', 15),
        h('span', { class: 'mode-toggle-label', text: 'Edit mode' }),
    );
    const leftToggle = h('button', { class: 'icon-btn panel-toggle left-toggle', title: 'Hierarchy', attrs: { type: 'button', 'aria-label': 'Toggle hierarchy' } }, icon('layers', 16));
    const rightToggle = h('button', { class: 'icon-btn panel-toggle', title: 'Inspector', attrs: { type: 'button', 'aria-label': 'Toggle inspector' } }, icon('sliders', 16));

    app.append(
        h(
            'header',
            { class: 'topbar' },
            h('div', { class: 'brand' }, logo(22, 'brand-mark'), wordmark(24, 'brand-name')),
            menuSlot,
            h('div', { class: 'spacer' }),
            sceneName.el,
            stepsSlot,
            h('div', { class: 'spacer' }),
            modeToggle,
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
            h('section', { class: 'center' }, h('div', { class: 'stage' }, toolbarSlot, viewportEl), h('div', { class: 'splitter horizontal dock-splitter', dataset: { side: 'dock' } }), dockSlot),
            h('div', { class: 'splitter', dataset: { side: 'right' } }),
            right,
        ),
        statusSlot,
    );
    restoreLayout(app);
    clampLayout(app);
    window.addEventListener('resize', () => clampLayout(app));
    installSplitters(app);
    /** Opens, closes or (without `open`) toggles a side panel: a column, or on narrow screens a drawer, one at a time. */
    const setPanel = (side: 'left' | 'right', open?: boolean) => {
        if (isNarrow()) {
            const shown = app.classList.toggle(`show-${side}`, open);
            if (shown) app.classList.remove(`show-${side === 'left' ? 'right' : 'left'}`);
        } else app.classList.toggle(`hide-${side}`, open === undefined ? undefined : !open);
        leftToggle.setAttribute('aria-pressed', String(app.classList.contains('show-left')));
        rightToggle.setAttribute('aria-pressed', String(app.classList.contains('show-right')));
    };
    leftToggle.addEventListener('click', () => setPanel('left'));
    rightToggle.addEventListener('click', () => setPanel('right'));

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

    // Hooks below that use the editor or the commands run later, on input.
    const shaders = new ShaderManager(runtime, store);
    // Compressed copies of the textures (KTX2), made in the background; the scene shows each once it exists.
    const derived = new DerivedAssets(
        store,
        () => new Worker(new URL('./derive/derive.worker.ts', import.meta.url), { type: 'module', name: 'morglay-texture-encoder' }),
        new URL(encoderWasm, location.href).href,
        encoderWorkers(),
    );
    const sync = new SceneSync(runtime, store, shaders, derived);
    derived.onRefresh((asset, role) => sync.refreshTexture(asset, role));
    derived.onReplaced((asset) => sync.reloadAsset(asset));
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
    // The player controller's joystick and hints go over the view.
    const player = new Player(runtime, store, sync, picker, compiler, { controls: viewportEl, aiServices: (): ModelServices => models, chat: (req) => scriptChat(req, (model, usage) => editor.usage.script(model, usage)) });
    // Agent models: the editor loads cached copies by itself and asks before downloading.
    const models = new ModelServices(runtime, player.speech, () => store.doc.aiModels, { policy: 'ask', backend: savedBackend() });
    const graph = new RenderGraphController(runtime, store, shaders, sync);
    const overlayDrawers: ((ctx: CanvasRenderingContext2D) => void)[] = [];
    const viewport = new Viewport(viewportEl, runtime, store, sync, picker, camera, gizmo, {
        onContextMenu: (_x, _y, cx, cy, id) => {
            const cmd = (c: string, patch?: Partial<MenuItem>) => commands.item(c, patch);
            showMenu(
                id
                    ? [
                          cmd('view.frame', { label: 'Frame' }),
                          cmd('edit.duplicate'),
                          cmd('edit.delete'),
                          cmd('edit.hide', { label: 'Hide' }),
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
            if (ref.startsWith('library:')) {
                const item = draggedLibraryItem(ref.slice(8));
                if (!item) return;
                // A sound plays from the object it was dropped on, else from a new sound object there.
                void editor
                    .addFromLibrary(item, { at: point })
                    .then(({ asset }) => asset.kind === 'audio' && editor.addSound(asset.id, hitId ? [hitId] : [], hitId ? undefined : point))
                    .catch((e) => toast(e?.message || String(e), 'error'));
                return;
            }
            const asset = store.doc.assets.find((a) => a.id === ref);
            if (asset?.kind === 'model') editor.addModel(ref, point);
            else if (asset?.kind === 'audio') store.select(editor.addSound(ref, hitId ? [hitId] : [], hitId ? undefined : point));
            else if (asset?.kind === 'texture') editor.applyTexture(ref, hitId && store.node(hitId)?.mesh ? [hitId] : store.selection);
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
        captured: () => editor.view === 'walk',
        drawExtra: (ctx) => overlayDrawers.forEach((fn) => fn(ctx)),
        play: {
            active: () => player.state !== 'stopped',
            gameCamera: () => player.usesGameCamera,
            pointer: (type, x, y, button, id, touch) => player.pointerEvent(type, x, y, button, id, touch),
            wheel: (d) => player.wheelEvent(d),
        },
    });
    const editor: Editor = new Editor({ store, runtime, sync, picker, camera, autosave, shaders, compiler, player, graph, models, viewport, derived });
    const commands = new Commands(
        editorCommands(editor, {
            rename: () => {
                if (!store.primary) return;
                setEditMode(true);
                hierarchy.startRename(store.primary.id);
            },
            toggleDock: () => {
                setEditMode(true);
                dock.toggle();
            },
            toggleEditMode: () => setEditMode(!store.prefs.editMode),
        }),
    );
    new WalkController(editor, viewport.overlay, viewportEl);
    new ReferenceRoom(editor, viewportEl);
    overlayDrawers.push(pipelineOverlay(editor));
    const terrainBrush = new TerrainBrush(editor, viewport.overlay, viewportEl);
    overlayDrawers.push((ctx) => terrainBrush.draw(ctx));
    gizmo.hidden = () => terrainBrush.active;

    store.on('change', (hint) => sync.sync(hint));
    store.on('prefs', (p) => runtime.setGridVisible(p.grid && !store.playing));
    // The viewport's frame rate limit and resolution (View menu, or the frame rate in the status bar).
    runtime.setViewport(store.prefs.viewportFps, store.prefs.viewportQuality);
    runtime.setAdaptive(store.prefs.adaptiveResolution);
    runtime.setQualityOverride(store.prefs.previewQuality === 'scene' ? null : store.prefs.previewQuality);
    store.on('prefs', (p) => {
        runtime.setViewport(p.viewportFps, p.viewportQuality);
        runtime.setAdaptive(p.adaptiveResolution);
        runtime.setQualityOverride(p.previewQuality === 'scene' ? null : p.previewQuality);
    });
    sync.sync();
    runtime.setGridVisible(store.prefs.grid);
    store.on('selection', (sel) => {
        if (editor.focusedPart && !sel.includes(editor.focusedPart.node)) editor.focusedPart = null;
    });

    // ------------------------------------------------------------- panels
    const hierarchy = new HierarchyPanel(editor, commands, () => createMenu(editor));
    const assets = new AssetsPanel(editor);
    left.append(hierarchy.el, h('div', { class: 'splitter horizontal', dataset: { side: 'assets' } }), assets.el);
    installSplitters(app);

    const dock = new Dock(editor, app);
    dockSlot.append(dock.el);

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
            h('span', { text: `${count} script${one ? '' : 's'} from an opened file or an earlier version ${one ? 'is' : 'are'} paused. Scripts run JavaScript in this page: read ${one ? 'it' : 'them'} first.` }),
            button('Review', () => {
                const first = store.doc.scripts[0];
                if (!first) return;
                setEditMode(true);
                dock.open('script', first.id);
            }, 'small'),
            button('Enable Scripts', () => editor.enableScripts(), 'small primary'),
        );
    };
    compiler.on('trust', updateNotice);
    store.on('load', updateNotice);
    // Only changes without a hint touch the scripts.
    onChanges(store, (hint) => touches(hint) && updateNotice());
    updateNotice();

    const tabs = h('div', { class: 'tabs', attrs: { role: 'tablist' } });
    const inspectorTab = h('button', { class: 'tab active', text: 'Inspector', attrs: { type: 'button', role: 'tab' } });
    const sceneTab = h('button', { class: 'tab', text: 'Scene', attrs: { type: 'button', role: 'tab' } });
    const designTab = h('button', { class: 'tab', attrs: { type: 'button', role: 'tab' } }, icon('flag', 13), h('span', { text: 'Design' }));
    const aiTab = h('button', { class: 'tab', attrs: { type: 'button', role: 'tab' } }, icon('sparkle', 13), h('span', { text: 'AI' }));
    tabs.append(inspectorTab, sceneTab, designTab, aiTab);
    const scenePanel = new ScenePanel(editor);
    const inspector = new InspectorPanel(editor, () => showTab('scene'));
    const aiPanel = new AIPanel(editor, () => aiContext(editor, dock), {
        showDetails: () => showTab('design', true),
        build: () => commands.get('file.build').run(),
    });
    const start = new StartScreen(editor, {
        start: (request, images, fresh) => {
            showTab('ai');
            aiPanel.start(request, images, fresh);
        },
    });
    viewportEl.append(start.el);
    // A request in the chat starts the project as well: the start screen is not needed any more.
    aiPanel.agent.on('busy', (busy) => {
        if (busy && !start.el.hidden) start.close();
    });
    const designPanel = new DesignPanel(editor, {
        ask: (text, images) => {
            showTab('ai');
            aiPanel.send(text, images);
        },
    });
    new ShotView(editor, viewportEl);
    viewportEl.append(new AIStatus(aiPanel.agent, () => showTab('ai')).el);
    /**
     * Shows a tab of the right panel. The simple view has only the chat:
     * `edit` (a user's request for that tab) opens the full editor for the
     * others, which the simple view otherwise leaves alone. `reveal: false`
     * leaves a closed panel (or drawer) closed.
     */
    const showTab = (tab: RightTab, edit = false, reveal = true) => {
        if (tab !== 'ai' && !store.prefs.editMode) {
            if (!edit) return;
            setEditMode(true);
        }
        inspectorTab.classList.toggle('active', tab === 'inspector');
        sceneTab.classList.toggle('active', tab === 'scene');
        designTab.classList.toggle('active', tab === 'design');
        aiTab.classList.toggle('active', tab === 'ai');
        inspector.el.hidden = tab !== 'inspector';
        scenePanel.el.hidden = tab !== 'scene';
        designPanel.el.hidden = tab !== 'design';
        aiPanel.el.hidden = tab !== 'ai';
        if (!reveal) return;
        if (tab === 'ai' || tab === 'design') setPanel('right', true);
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
    editor.on('show-ai', () => showTab('ai'));
    editor.on('show-design', () => showTab('design', true));
    editor.on('show-scene', (key) => {
        showTab('scene', true);
        setPanel('right', true);
        if (key) scenePanel.reveal(key);
    });

    /**
     * The simple view (the scene and the chat, with the three steps above)
     * or the full editor (hierarchy, inspector, pipeline bar, code dock).
     * The assistant works the same in both.
     */
    const applyMode = () => {
        const edit = store.prefs.editMode;
        app.classList.toggle('simple', !edit);
        modeToggle.setAttribute('aria-pressed', String(edit));
        modeToggle.title = edit ? `Back to the simple view: the scene and the chat${commands.hint('view.editMode')}` : `Edit mode: the hierarchy, inspector, pipeline and code${commands.hint('view.editMode')}`;
        rightToggle.title = edit ? 'Inspector' : 'Assistant';
        rightToggle.replaceChildren(icon(edit ? 'sliders' : 'sparkle', 16));
        if (!edit) {
            showTab('ai', false, false);
            app.classList.remove('show-left');
        } else if (aiPanel.el.hidden && designPanel.el.hidden && scenePanel.el.hidden) showTab('inspector', false, false);
    };
    const setEditMode = (edit: boolean) => {
        if (edit !== store.prefs.editMode) store.setPrefs({ editMode: edit });
    };
    modeToggle.addEventListener('click', () => setEditMode(!store.prefs.editMode));
    let modeShown = store.prefs.editMode;
    store.on('prefs', (p) => {
        if (p.editMode === modeShown) return;
        modeShown = p.editMode;
        applyMode();
    });
    showTab(store.prefs.editMode ? 'inspector' : 'ai', false, false);
    applyMode();
    /** The chat is on the screen: what it shows needs no card of its own. */
    const chatInView = () => document.visibilityState === 'visible' && !aiPanel.el.hidden && aiPanel.el.offsetParent !== null;
    stepsSlot.append(new StepsBar(editor, () => showTab('design', true)).el);
    pipelineSlot.append(new PipelineBar(editor, { design: () => showTab('design', true), chatInView }).el);

    // Checkpoints refresh the assistant's memo and save versions; a notice tells when the assistant finished out of sight.
    new Checkpoints(editor, aiPanel.agent);
    aiPanel.agent.on('done', (d) => {
        // The chat in sight shows the answer itself: the card is for when it is not.
        if (chatInView()) return;
        const first = d.answer.replace(/[#*`>]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
        notices.show({
            kind: 'ai-done',
            key: 'ai-done',
            mascot: d.error ? 'error' : d.stopped ? 'idle' : 'done',
            title: d.error ? 'The assistant ran into an error' : d.stopped ? 'The assistant stopped' : 'The assistant finished',
            body: d.error ? d.error.slice(0, 200) : first.length > 180 ? first.slice(0, 177) + '...' : first,
            timeout: d.error ? 0 : 9000,
            actions: [{ label: 'Show', run: () => showTab('ai') }],
        });
    });
    // A Play session needed a model this browser does not have: agents keep
    // their defaults meanwhile. Asked once per page; the Behavior tab keeps a chip.
    const asked = new Set<string>();
    models.on('needed', (id) => {
        if (asked.has(id)) return;
        asked.add(id);
        const m = models.model(id);
        if (!m) return;
        const size = 'size' in m ? ` (${formatBytes(m.size)})` : '';
        notices.show({
            kind: 'model',
            key: `model-${id}`,
            icon: 'sparkle',
            title: 'Agents are playing without a model',
            body: `Nodes that use ${m.name} keep their keys at the defaults until it is downloaded once${size} from ${new URL(m.url, location.href).host} into this browser. It runs here; nothing is sent anywhere.`,
            timeout: 0,
            actions: [
                {
                    label: 'Download',
                    primary: true,
                    run: async () => {
                        setEditMode(true);
                        dock.show('behavior');
                        const ok = await models.download(id);
                        toast(ok ? `${m.name} is ready.` : `${m.name} could not be loaded: ${models.status(id).message ?? 'unknown error'}`, ok ? 'success' : 'error', 6000);
                    },
                },
                { label: 'Not now', run: () => {} },
            ],
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

    menuSlot.append(
        menubar(
            menuDefinitions(editor, commands, {
                toggleLeft: () => {
                    setEditMode(true);
                    setPanel('left');
                },
                toggleRight: () => setPanel('right'),
                showGraph: () => {
                    setEditMode(true);
                    dock.show('graph');
                },
                showAI: () => showTab('ai'),
                versions: () => openVersionHistory(editor),
            }),
        ),
    );
    toolbarSlot.append(toolbar(editor, commands, () => createMenu(editor), () => showTab('ai')));
    // "[Name.js:12]" in the console opens the file at the line.
    statusSlot.append(
        statusbar(editor, (file, line) => {
            setEditMode(true);
            const script = store.doc.scripts.find((s) => s.name === file);
            if (script) dock.open('script', script.id)?.reveal(line);
            const shader = store.doc.shaders.find((s) => s.name === file);
            if (shader) dock.open('shader', shader.id)?.reveal(line);
        }),
    );

    const updateTitle = () => {
        sceneName.render();
        document.title = `${store.doc.name} - Morglay`;
    };
    onChanges(store, (hint) => touches(hint, 'env') && updateTitle());
    store.on('load', updateTitle);
    updateTitle();

    store.on('playing', (playing) => {
        app.classList.toggle('playing', playing);
        // The game view has no editor grid.
        runtime.setGridVisible(!playing && store.prefs.grid);
    });
    // View > Navigation Mesh: what the characters walk on, in the editor and in Play.
    const navOverlay = new NavOverlay(runtime, store, sync, (text) => logInfo(text));
    const updateNavOverlay = () => navOverlay.setVisible(store.prefs.navMesh);
    store.on('prefs', updateNavOverlay);
    updateNavOverlay();
    // GI probe spheres are an editor view aid: hidden while playing.
    const updateProbeHelpers = () => runtime.gi.setHelpersVisible(store.prefs.giProbes && !store.playing);
    store.on('prefs', updateProbeHelpers);
    store.on('playing', updateProbeHelpers);
    updateProbeHelpers();
    player.on('state', (st) => app.classList.toggle('paused', st === 'paused'));
    // Scenes without a camera node play through the editor camera, which scripts may have moved.
    player.on('state', (st) => {
        if (st === 'stopped') camera.reapply();
    });

    commands.install(editor);
    installDropGuard();
    autosave.schedule();
    if (unreadableAutosave) {
        const lost = unreadableAutosave;
        void dialog(
            'The saved scene could not be opened',
            `The scene this browser kept could not be read (${lost.reason}), so a new scene was started. Download the saved scene to keep it, for example to open it in a newer version of the editor.`,
            [{ label: 'Close' }, { label: 'Download It', value: 'download', primary: true }],
        ).then((v) => {
            if (v === 'download') download(new Blob([lost.raw], { type: 'application/json' }), 'saved-scene.scene.json');
        });
    }
    void otherTabsOpen().then((others) => {
        if (others) toast('The editor is also open in another tab. Both keep their scene in this browser, so the tab that saves last replaces the other one. Use one tab, or save a project file first.', 'info', 12000);
    });

    (window as any).__editor = editor;
    openLinkedScene(editor);
}

/**
 * ?open=<link> opens that scene or project (an example hosted anywhere),
 * asking first when the current scene would be lost. The parameter is
 * taken off the address, so a reload does not open it again.
 */
function openLinkedScene(editor: Editor) {
    const params = new URLSearchParams(location.search);
    const link = params.get('open');
    if (!link) return;
    params.delete('open');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    void editor.openUrl(link);
}

/**
 * The scene's name in the top bar: a click edits it in place (Enter or
 * leaving the field keeps it, Escape cancels). The assistant names a scene
 * nobody has named yet.
 */
function sceneNameField(store: Store): { el: HTMLElement; render(): void } {
    const label = h('span', { class: 'scene-name-text' });
    const button = h('button', { class: 'scene-name', title: 'Rename the scene', attrs: { type: 'button' } }, label, icon('edit', 12, 'scene-name-edit'));
    const input = h('input', { class: 'scene-name-input', attrs: { type: 'text', spellcheck: 'false', 'aria-label': 'Scene name', maxlength: 120, hidden: true } });
    const el = h('div', { class: 'scene-name-wrap' }, button, input);
    const render = () => {
        const name = store.doc.name;
        label.textContent = name;
        button.classList.toggle('untitled', name === UNTITLED_SCENE);
    };
    const finish = (keep: boolean) => {
        if (input.hidden) return;
        const name = input.value.replace(/\s+/g, ' ').trim();
        input.hidden = true;
        button.hidden = false;
        if (keep && name && name !== store.doc.name) {
            store.commit('Rename Scene', (d) => {
                d.name = name;
            }, { env: true });
        }
        render();
    };
    button.addEventListener('click', () => {
        input.value = store.doc.name === UNTITLED_SCENE ? '' : store.doc.name;
        input.placeholder = store.doc.name;
        button.hidden = true;
        input.hidden = false;
        input.focus();
        input.select();
    });
    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        // Not while an input method composes (Enter ends the composition first).
        if (e.isComposing) return;
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    store.on('load', () => finish(false));
    render();
    return { el, render };
}

/** What the assistant is told about the editor with every message. */
function aiContext(editor: Editor, dock: Dock): string {
    const store = editor.store;
    const lines: string[] = [];
    const sel = store.selection.map((id) => store.node(id)).filter(Boolean).slice(0, 12);
    lines.push(sel.length ? `Selected: ${sel.map((n) => `${n!.name} (id ${n!.id}, ${n!.player ? 'player' : n!.character ? 'character' : n!.tree ? 'tree' : nodeIcon(n!)})`).join(', ')}` : 'Selected: nothing');
    const doc = dock.activeDoc();
    if (doc) lines.push(`Open in the code editor: ${doc.name} (${doc.kind} id ${doc.id})`);
    const f = editor.focusedPart;
    if (f) lines.push(`Picked model mesh: ${f.path} of ${store.node(f.node)?.name ?? f.node}`);
    lines.push(`Scene "${store.doc.name}": ${store.doc.nodes.length} objects, ${store.doc.prefabs.length} prefabs, ${store.doc.scripts.length} scripts, ${store.doc.shaders.length} shaders. Play mode: ${editor.player.state}.`);
    if (store.doc.name === UNTITLED_SCENE) lines.push('The scene has no name yet: give it a short one (update_design scene_name) as soon as you know what it is.');
    lines.push(`The user sees ${store.prefs.editMode ? 'the full editor (hierarchy, inspector, pipeline bar)' : 'the simple view: the scene, this chat and the three steps; no panels'}.`);
    if (!editor.compiler.trusted && store.doc.scripts.length) lines.push('Scripts are paused: the scene was opened from a file and the user has not enabled its scripts yet.');
    lines.push(...pipelineSummary(store.doc, editor.runtime.fps, editor.runtime.fpsLimit), ...designSummary(store.doc), ...memoLines(store.doc));
    return lines.join('\n');
}


/**
 * Files dropped outside the drop targets (viewport, AI tab, brief) would make
 * the browser open them and leave the editor, losing the undo history,
 * unapplied code and a running AI request.
 */
function installDropGuard() {
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    document.addEventListener('dragover', (e) => {
        if (files(e)) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
        if (!files(e) || e.defaultPrevented) return;
        e.preventDefault();
        toast('Drop files onto the viewport to import them, or onto the AI tab to attach them.', 'info');
    });
}

function isNarrow() {
    return window.matchMedia('(max-width: 900px)').matches;
}

function restoreLayout(app: HTMLElement) {
    for (const [k, v] of Object.entries(readLocal<Record<string, string>>(LAYOUT_KEY, {}) ?? {})) app.style.setProperty(k, String(v));
}

type Split = 'left' | 'right' | 'assets' | 'dock';

/** What each splitter sizes, within the window or the panel holding it. */
const SPLITS: Record<Split, { prop: string; holder: string; min: number; max: (holder: DOMRect) => number }> = {
    left: { prop: '--left-w', holder: '.workspace', min: 180, max: () => window.innerWidth * 0.4 },
    right: { prop: '--right-w', holder: '.workspace', min: 240, max: () => window.innerWidth * 0.5 },
    assets: { prop: '--assets-h', holder: '.side.left', min: 60, max: (r) => r.height - 120 },
    dock: { prop: '--dock-h', holder: '.center', min: 120, max: (r) => r.height - 140 },
};

function setSize(app: HTMLElement, split: Split, px: number) {
    const { prop, holder, min, max } = SPLITS[split];
    const box = app.querySelector(holder)!.getBoundingClientRect();
    // A hidden holder (a closed drawer) has no size to fit in.
    if (box.height) app.style.setProperty(prop, clampPx(px, min, Math.max(min, max(box))));
}

/** Keeps panel sizes (saved on a larger window, say) within the window, as the splitters do. */
function clampLayout(app: HTMLElement) {
    for (const split of Object.keys(SPLITS) as Split[]) {
        const v = parseFloat(app.style.getPropertyValue(SPLITS[split].prop));
        if (Number.isFinite(v)) setSize(app, split, v);
    }
}

function saveLayout(app: HTMLElement) {
    const out: Record<string, string> = {};
    for (const { prop: k } of Object.values(SPLITS)) {
        const v = app.style.getPropertyValue(k);
        if (v) out[k] = v;
    }
    writeLocal(LAYOUT_KEY, out);
}

function installSplitters(app: HTMLElement) {
    app.querySelectorAll<HTMLElement>('.splitter:not([data-ready])').forEach((sp) => {
        sp.dataset.ready = '1';
        sp.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            sp.setPointerCapture(e.pointerId);
            sp.classList.add('active');
            const split = sp.dataset.side as Split;
            // Sizes from the holder's inner edge, keeping the pointer in the middle of the gap.
            const box = sp.parentElement!.getBoundingClientRect();
            const vertical = split === 'left' || split === 'right';
            const inset = (parseFloat(getComputedStyle(sp.parentElement!).paddingLeft) || 0) + (vertical ? sp.offsetWidth : sp.offsetHeight) / 2;
            const move = (ev: PointerEvent) =>
                setSize(app, split, split === 'left' ? ev.clientX - box.left - inset : split === 'right' ? box.right - inset - ev.clientX : box.bottom - inset - ev.clientY);
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
            h('div', { class: 'brand' }, logo(22, 'brand-mark'), wordmark(24, 'brand-name')),
            mascotPose('ask', 170, 'unsupported-heron'),
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

/** Texture encoders to run at once: two on machines with cores and memory to spare, else one. */
function encoderWorkers(): number {
    const cores = navigator.hardwareConcurrency || 2;
    const memory = (navigator as any).deviceMemory ?? 4;
    return cores >= 8 && memory >= 8 ? 2 : 1;
}
