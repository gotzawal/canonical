import { PARTICLE_PRESETS } from './core/particles';
import { TERRAIN_SHAPES } from './core/terrainGen';
import { SPECIES_NAME, TREE_SPECIES } from './core/trees';
import { version as engineVersion } from '../../package.json';
import type { Commands } from './commands';
import type { Editor } from './editor';
import { createAssetMenu } from './ui/assetsPanel';
import { buildInfo } from './ui/statusbar';
import { h } from './ui/dom';
import { mascotPose } from './ui/mascot';
import { dialog, MenuItem, toast } from './ui/overlays';
import { showBehaviorReference } from './ui/behaviorReference';
import { importFromLink, openFromLink, openLibraryDialog } from './ui/libraryDialog';
import { openRecordsDialog } from './ui/recordsDialog';
import { showReference } from './ui/reference';
import { glassOn } from './ui/theme';
import { viewportMenu } from './ui/viewportMenu';

export function createMenu(editor: Editor): MenuItem[] {
    return [
        { label: 'Empty', icon: 'empty', action: () => editor.createEmpty() },
        { separator: true },
        { label: 'Cube', icon: 'cube', action: () => editor.createPrimitive('box') },
        { label: 'Sphere', icon: 'sphere', action: () => editor.createPrimitive('sphere') },
        { label: 'Plane', icon: 'plane', action: () => editor.createPrimitive('plane') },
        { label: 'Cylinder', icon: 'cylinder', action: () => editor.createPrimitive('cylinder') },
        { label: 'Cone', icon: 'cone', action: () => editor.createPrimitive('cone') },
        { label: 'Torus', icon: 'torus', action: () => editor.createPrimitive('torus') },
        { label: 'Ramp', icon: 'ramp', action: () => editor.createPrimitive('ramp') },
        { label: 'Stairs', icon: 'stairs', action: () => editor.createPrimitive('stairs') },
        { label: 'Capsule', icon: 'capsule', action: () => editor.createPrimitive('capsule') },
        { label: 'Player', icon: 'play', action: () => editor.createPlayer() },
        { label: 'Character (NPC)', icon: 'walk', action: () => editor.createCharacter() },
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
        {
            label: 'Particles',
            icon: 'sparkle',
            submenu: PARTICLE_PRESETS.map((pr) => ({ label: pr.label, icon: 'sparkle', action: () => void editor.createParticles(pr.id) })),
        },
        { label: 'Grass', icon: 'grass', action: () => void editor.createGrass() },
        { label: 'Rain', icon: 'rain', action: () => void editor.createRain() },
        { label: 'Water', icon: 'mirror', action: () => void editor.createWater() },
        {
            label: 'Terrain',
            icon: 'terrain',
            submenu: TERRAIN_SHAPES.map((shape) => ({
                label: shape.charAt(0).toUpperCase() + shape.slice(1),
                icon: 'terrain',
                action: () => void editor.createTerrain({ shape }).catch((e) => toast(e?.message || String(e), 'error')),
            })),
        },
        { label: 'Scatter', icon: 'scatter', action: () => editor.newScatter() },
        {
            label: 'Tree',
            icon: 'plant',
            submenu: [
                ...TREE_SPECIES.map((sp) => ({ label: SPECIES_NAME[sp], icon: 'plant', action: () => void editor.createTree(sp) })),
                { separator: true },
                { label: 'Forest', icon: 'scatter', action: () => void editor.newForest() },
            ],
        },
        { separator: true },
        { label: 'Camera', icon: 'camera', action: () => editor.createCamera() },
        { label: 'Model from File...', icon: 'model', action: () => void editor.importModelDialog() },
        { label: 'Model from Library...', icon: 'library', action: () => openLibraryDialog(editor, { kind: 'model' }) },
        { separator: true },
        ...createAssetMenu(editor),
    ];
}

export function menuDefinitions(
    editor: Editor,
    commands: Commands,
    panels: { toggleLeft: () => void; toggleRight: () => void; showGraph: () => void; showAI: () => void; versions: () => void },
) {
    const store = editor.store;
    const cmd = (id: string, patch?: Partial<MenuItem>) => commands.item(id, patch);
    const hasSel = () => store.selection.length > 0;
    let history = { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' };
    store.on('history', (hs) => (history = hs));
    return [
        {
            label: 'File',
            items: (): MenuItem[] => [
                { label: 'New Empty Scene', icon: 'plus', action: () => void editor.newScene('empty') },
                { label: 'Open Example: Night Laundromat', action: () => void editor.newScene('laundromat') },
                { label: 'Open Example: Island', action: () => void editor.newScene('island') },
                { separator: true },
                cmd('file.open'),
                { label: 'Open Link...', icon: 'link', action: () => void openFromLink(editor) },
                cmd('file.save'),
                cmd('file.saveProject'),
                cmd('file.saveProjectLean'),
                { label: 'Version History...', icon: 'history', action: panels.versions },
                { label: 'Delete Planning Images...', icon: 'trash', action: () => void openRecordsDialog(editor) },
                { separator: true },
                cmd('file.build'),
                { separator: true },
                { label: 'Import Model...', icon: 'model', action: () => void editor.importModelDialog() },
                { label: 'Import Texture...', icon: 'image', action: () => void editor.importTextureDialog() },
                { label: 'Import Sound...', icon: 'speaker', action: () => void editor.importSoundDialog() },
                { label: 'Import from Link...', icon: 'link', action: () => void importFromLink(editor) },
                { label: 'Library...', icon: 'library', action: () => openLibraryDialog(editor) },
            ],
        },
        {
            label: 'Edit',
            items: (): MenuItem[] => {
                return [
                    cmd('edit.undo', { label: history.canUndo ? `Undo ${history.undoLabel}` : 'Undo', enabled: () => history.canUndo }),
                    cmd('edit.redo', { label: history.canRedo ? `Redo ${history.redoLabel}` : 'Redo', enabled: () => history.canRedo }),
                    { separator: true },
                    cmd('edit.rename'),
                    cmd('edit.duplicate'),
                    cmd('edit.delete'),
                    cmd('edit.group'),
                    { separator: true },
                    cmd('edit.selectAll'),
                    cmd('edit.deselect', { enabled: hasSel }),
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
                cmd('view.frame'),
                cmd('view.frameAll'),
                { separator: true },
                ...['front', 'back', 'right', 'left', 'top', 'bottom'].map((v) => cmd(`view.${v}`)),
                { separator: true },
                cmd('view.grid', { icon: undefined, checked: () => store.prefs.grid }),
                { label: 'Helpers', checked: () => store.prefs.helpers, action: () => store.setPrefs({ helpers: !store.prefs.helpers }) },
                { label: 'Snapping', checked: () => store.prefs.snap, action: () => store.setPrefs({ snap: !store.prefs.snap }) },
                { label: 'Glass Effects', checked: () => glassOn(store.prefs), action: () => store.setPrefs({ glass: !glassOn(store.prefs) }) },
                { label: 'Navigation Mesh', checked: () => store.prefs.navMesh, action: () => store.setPrefs({ navMesh: !store.prefs.navMesh }) },
                { separator: true },
                ...viewportMenu(store),
                { separator: true },
                cmd('view.editMode', { icon: undefined, checked: () => store.prefs.editMode }),
                { label: 'Toggle Hierarchy Panel', action: panels.toggleLeft },
                { label: 'Toggle Inspector Panel', action: panels.toggleRight },
                cmd('dock.toggle'),
                { label: 'Render Graph', icon: 'graph', action: panels.showGraph },
                { label: 'AI Assistant', icon: 'sparkle', action: panels.showAI },
            ],
        },
        {
            label: 'Play',
            items: (): MenuItem[] => {
                const st = editor.player.state;
                return [
                    cmd('play.toggle', { label: st === 'stopped' ? 'Play' : 'Stop', icon: st === 'stopped' ? 'play' : 'stop' }),
                    cmd('play.pause', { label: st === 'paused' ? 'Resume' : 'Pause' }),
                    { label: 'Next Frame', icon: 'step', enabled: () => st === 'paused', action: () => editor.player.step() },
                ];
            },
        },
        {
            label: 'Help',
            items: (): MenuItem[] => [
                cmd('help.shortcuts'),
                { label: 'Scripting & Shader Reference', icon: 'code', action: () => showReference() },
                { label: 'Behavior Tree Reference', icon: 'btSelector', action: () => showBehaviorReference() },
                { label: 'About', icon: 'info', action: () => showAbout(editor) },
            ],
        },
    ];
}

export function showAbout(editor: Editor) {
    const b = buildInfo();
    const body = h(
        'div',
        { class: 'about' },
        h(
            'div',
            { class: 'about-intro' },
            mascotPose('stand', 128),
            h('p', { text: 'An open-source, AI-automated development editor based on the Orillusion WebGPU engine. It runs entirely in your browser: scenes are autosaved to this browser, imported files are kept in IndexedDB, and nothing is uploaded anywhere. The optional AI assistant sends your messages and a description of the scene to OpenRouter, only when you use it.' }),
        ),
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
            h('dt', { text: 'License' }),
            h('dd', { text: 'Editor AGPL-3.0, engine MIT' }),
        ),
        b.repo ? h('p', null, h('a', { text: `github.com/${b.repo}`, attrs: { href: `https://github.com/${b.repo}`, target: '_blank', rel: 'noopener' } })) : null,
    );
    void dialog('About Morglay', body);
}
