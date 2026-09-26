import { version as engineVersion } from '../../package.json';
import type { Editor } from './editor';
import { createAssetMenu } from './ui/assetsPanel';
import { buildInfo } from './ui/statusbar';
import { h, shortcutLabel } from './ui/dom';
import { showBuildDialog } from './ui/buildDialog';
import { dialog, MenuItem } from './ui/overlays';
import { showReference } from './ui/reference';

export function createMenu(editor: Editor): MenuItem[] {
    return [
        { label: 'Empty', icon: 'empty', action: () => editor.createEmpty() },
        { separator: true },
        { label: 'Cube', icon: 'cube', action: () => editor.createPrimitive('box') },
        { label: 'Sphere', icon: 'sphere', action: () => editor.createPrimitive('sphere') },
        { label: 'Plane', icon: 'plane', action: () => editor.createPrimitive('plane') },
        { label: 'Cylinder', icon: 'cylinder', action: () => editor.createPrimitive('cylinder') },
        { label: 'Torus', icon: 'torus', action: () => editor.createPrimitive('torus') },
        { label: 'Ramp', icon: 'ramp', action: () => editor.createPrimitive('ramp') },
        { label: 'Stairs', icon: 'stairs', action: () => editor.createPrimitive('stairs') },
        { label: 'Capsule', icon: 'capsule', action: () => editor.createPrimitive('capsule') },
        { label: 'Player Capsule', icon: 'capsule', action: () => editor.createPlayerCapsule() },
        { separator: true },
        {
            label: 'Prefab',
            icon: 'prefab',
            submenu: [
                { label: 'Make Prefab from Selection', enabled: () => editor.store.selection.length > 0, action: () => editor.createPrefab() },
                ...(editor.store.doc.prefabs.length ? [{ separator: true } as MenuItem] : []),
                ...editor.store.doc.prefabs.map((p) => ({ label: `Place ${p.name}`, icon: 'prefab', action: () => editor.placePrefab(p.id) })),
            ],
        },
        { separator: true },
        { label: 'Directional Light', icon: 'sun', action: () => editor.createLight('directional') },
        { label: 'Point Light', icon: 'bulb', action: () => editor.createLight('point') },
        { label: 'Spot Light', icon: 'spot', action: () => editor.createLight('spot') },
        { separator: true },
        { label: 'Camera', icon: 'camera', action: () => editor.createCamera() },
        { label: 'Model from File...', icon: 'model', action: () => void editor.importModelDialog() },
        { separator: true },
        ...createAssetMenu(editor),
    ];
}

export function menuDefinitions(
    editor: Editor,
    panels: { rename: () => void; toggleLeft: () => void; toggleRight: () => void; toggleDock: () => void; showGraph: () => void; showAI: () => void },
) {
    const store = editor.store;
    const hasSel = () => store.selection.length > 0;
    let history = { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' };
    store.on('history', (hs) => (history = hs));
    return [
        {
            label: 'File',
            items: (): MenuItem[] => [
                { label: 'New Scene', icon: 'plus', action: () => void editor.newScene('default') },
                { label: 'New Empty Scene', action: () => void editor.newScene('empty') },
                { label: 'Open Example: Showcase', action: () => void editor.newScene('showcase') },
                { separator: true },
                { label: 'Open Scene or Project...', icon: 'open', shortcut: 'Mod+O', action: () => void editor.openSceneFile() },
                { label: 'Save Scene File', icon: 'save', shortcut: 'Mod+S', action: () => void editor.saveSceneFile() },
                { label: 'Save Project (.zip)', icon: 'save', shortcut: 'Mod+Shift+S', action: () => void editor.saveProjectFile() },
                { separator: true },
                { label: 'Build & Deploy...', icon: 'rocket', shortcut: 'Mod+B', action: () => showBuildDialog(editor) },
                { separator: true },
                { label: 'Import Model...', icon: 'model', action: () => void editor.importModelDialog() },
                { label: 'Import Texture...', icon: 'image', action: () => void editor.importTextureDialog() },
            ],
        },
        {
            label: 'Edit',
            items: (): MenuItem[] => {
                return [
                    {
                        label: history.canUndo ? `Undo ${history.undoLabel}` : 'Undo',
                        icon: 'undo',
                        shortcut: 'Mod+Z',
                        enabled: () => history.canUndo,
                        action: () => store.undo(),
                    },
                    {
                        label: history.canRedo ? `Redo ${history.redoLabel}` : 'Redo',
                        icon: 'redo',
                        shortcut: 'Mod+Shift+Z',
                        enabled: () => history.canRedo,
                        action: () => store.redo(),
                    },
                    { separator: true },
                    { label: 'Rename', shortcut: 'F2', enabled: () => !!store.primary, action: panels.rename },
                    { label: 'Duplicate', icon: 'copy', shortcut: 'Mod+D', enabled: hasSel, action: () => editor.duplicateSelection() },
                    { label: 'Delete', icon: 'trash', shortcut: 'Del', enabled: hasSel, action: () => editor.deleteSelection() },
                    { label: 'Group', icon: 'layers', shortcut: 'Mod+G', enabled: hasSel, action: () => editor.groupSelection() },
                    { separator: true },
                    { label: 'Select All', shortcut: 'Mod+A', action: () => editor.selectAll() },
                    { label: 'Deselect', shortcut: 'Esc', enabled: hasSel, action: () => store.select([]) },
                    { separator: true },
                    { label: 'Reset Transform', enabled: hasSel, action: () => editor.resetTransform('all') },
                    { label: 'Drop to Ground', enabled: hasSel, action: () => editor.dropToGround() },
                ];
            },
        },
        { label: 'Create', items: () => createMenu(editor) },
        {
            label: 'View',
            items: (): MenuItem[] => [
                { label: 'Frame Selection', icon: 'focus', shortcut: 'F', action: () => editor.frameSelection() },
                { label: 'Frame All', shortcut: 'Home', action: () => editor.viewport.frameAll() },
                { separator: true },
                { label: 'Front', shortcut: '1', action: () => editor.camera.setView(0, 0) },
                { label: 'Back', shortcut: 'Shift+1', action: () => editor.camera.setView(180, 0) },
                { label: 'Right', shortcut: '3', action: () => editor.camera.setView(90, 0) },
                { label: 'Left', shortcut: 'Shift+3', action: () => editor.camera.setView(270, 0) },
                { label: 'Top', shortcut: '7', action: () => editor.camera.setView(store.camera.yaw, 89.5) },
                { label: 'Bottom', shortcut: 'Shift+7', action: () => editor.camera.setView(store.camera.yaw, -89.5) },
                { separator: true },
                { label: 'Grid', shortcut: 'G', checked: () => store.prefs.grid, action: () => store.setPrefs({ grid: !store.prefs.grid }) },
                { label: 'Helpers', checked: () => store.prefs.helpers, action: () => store.setPrefs({ helpers: !store.prefs.helpers }) },
                { label: 'Snapping', checked: () => store.prefs.snap, action: () => store.setPrefs({ snap: !store.prefs.snap }) },
                { separator: true },
                { label: 'Toggle Hierarchy Panel', action: panels.toggleLeft },
                { label: 'Toggle Inspector Panel', action: panels.toggleRight },
                { label: 'Toggle Code Panel', icon: 'panelBottom', shortcut: 'Mod+J', action: panels.toggleDock },
                { label: 'Render Graph', icon: 'graph', action: panels.showGraph },
                { label: 'AI Assistant', icon: 'sparkle', action: panels.showAI },
            ],
        },
        {
            label: 'Play',
            items: (): MenuItem[] => {
                const st = editor.player.state;
                return [
                    { label: st === 'stopped' ? 'Play' : 'Stop', icon: st === 'stopped' ? 'play' : 'stop', shortcut: 'Mod+P', action: () => editor.togglePlay() },
                    { label: st === 'paused' ? 'Resume' : 'Pause', icon: 'pause', shortcut: 'Mod+Shift+P', enabled: () => st !== 'stopped', action: () => editor.pausePlay() },
                    { label: 'Next Frame', icon: 'step', enabled: () => st === 'paused', action: () => editor.player.step() },
                ];
            },
        },
        {
            label: 'Help',
            items: (): MenuItem[] => [
                { label: 'Keyboard Shortcuts', icon: 'keyboard', shortcut: '?', action: () => showShortcuts() },
                { label: 'Scripting & Shader Reference', icon: 'code', action: () => showReference() },
                { label: 'About', icon: 'info', action: () => showAbout(editor) },
            ],
        },
    ];
}

const SHORTCUTS: [string, string][] = [
    ['Left drag', 'Orbit camera'],
    ['Right / middle drag, Shift + left drag', 'Pan camera'],
    ['Wheel / pinch', 'Zoom toward cursor'],
    ['Click / Shift + click', 'Select / add to selection'],
    ['Double click', 'Frame object'],
    ['Q W E R', 'Select, move, rotate, scale tool'],
    ['X', 'Toggle world / local gizmo space'],
    ['V', 'Walk at eye height (WASD, mouse, Shift run, Esc stop)'],
    ['Ctrl while dragging', 'Toggle snapping'],
    ['F / Home', 'Frame selection / frame all'],
    ['1 3 7 (Shift for opposite)', 'Front, right, top view'],
    ['Mod+Z / Mod+Shift+Z', 'Undo / redo'],
    ['Mod+D / Delete', 'Duplicate / delete'],
    ['Mod+G', 'Group selection'],
    ['H', 'Hide / show selection'],
    ['G', 'Toggle grid'],
    ['F2', 'Rename'],
    ['Mod+S / Mod+O', 'Save / open scene file'],
    ['Mod+Shift+S', 'Save the project with its planning images and snapshots (.zip)'],
    ['Mod+B', 'Build & Deploy (run, download or publish the game)'],
    ['Esc', 'Cancel drag or clear selection'],
    ['Mod+P / Mod+Shift+P', 'Play or stop / pause'],
    ['Mod+J', 'Show or hide the code and render graph panel'],
    ['Mod+S in the code editor', 'Apply the script or shader'],
    ['Mod+/ in the code editor', 'Comment or uncomment lines'],
];

export function showShortcuts() {
    const table = h(
        'table',
        { class: 'shortcuts' },
        SHORTCUTS.map(([k, v]) => h('tr', null, h('td', null, h('kbd', { text: shortcutLabel(k) })), h('td', { text: v }))),
    );
    void dialog('Keyboard shortcuts', table);
}

export function showAbout(editor: Editor) {
    const b = buildInfo();
    const body = h(
        'div',
        { class: 'about' },
        h('p', { text: 'An open-source, AI-automated development editor based on the Orillusion WebGPU engine. It runs entirely in your browser: scenes are autosaved to this browser, imported files are kept in IndexedDB, and nothing is uploaded anywhere. The optional AI assistant sends your messages and a description of the scene to OpenRouter, only when you use it.' }),
        h(
            'dl',
            null,
            h('dt', { text: 'Engine' }),
            h('dd', { text: `@orillusion/core ${engineVersion} (built from this repository)` }),
            h('dt', { text: 'Build' }),
            h('dd', { text: b.sha ? `${b.sha.slice(0, 12)}${b.ref ? ' on ' + b.ref : ''}` : 'local development build' }),
            h('dt', { text: 'Built at' }),
            h('dd', { text: b.time ? new Date(b.time).toLocaleString() : '-' }),
            h('dt', { text: 'GPU' }),
            h('dd', { text: editor.runtime.adapterInfo }),
        ),
        b.repo ? h('p', null, h('a', { text: `github.com/${b.repo}`, attrs: { href: `https://github.com/${b.repo}`, target: '_blank', rel: 'noopener' } })) : null,
    );
    void dialog('About Canonical Editor', body);
}
