import type { Editor } from '../editor';
import { useCounts } from '../core/refs';
import { onChanges, touches } from './batch';
import { formatBytes } from '../core/assets';
import { shipsAsIs } from '../core/derived';
import { toast } from '../core/messages';
import { pickFiles } from '../core/persistence';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES } from '../core/templates';
import { clear, h, pressable } from './dom';
import { icon } from './icons';
import { MenuItem, showMenu } from './overlays';
import { openLibraryDialog } from './libraryDialog';
import { toggleSound } from './soundPreview';
import { iconButton } from './widgets';

/** Payload of dragged assets: an asset id, or "script:<id>" / "shader:<id>". */
export const ASSET_MIME = 'application/x-morglay-asset';

/** Imported models and textures, plus the project's scripts and shaders. */
export class AssetsPanel {
    readonly el: HTMLElement;
    private list: HTMLElement;
    private key = '';
    private rendering = false;
    private again = false;

    constructor(private editor: Editor) {
        this.list = h('div', { class: 'asset-list' });
        this.el = h(
            'div',
            { class: 'panel assets' },
            h(
                'div',
                { class: 'panel-header' },
                icon('image', 15),
                h('span', { class: 'panel-title', text: 'Assets' }),
                h('div', { class: 'spacer' }),
                iconButton('plus', 'Create script or shader', (e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    showMenu(createAssetMenu(editor), r.left, r.bottom + 4);
                }),
                iconButton('library', 'Library: models, materials and skies to use', () => openLibraryDialog(editor)),
                iconButton('upload', 'Import models, images or sounds', async () => {
                    const files = await pickFiles('.glb,.gltf,image/*,audio/*,.ogg,.opus,.m4a,.flac', true);
                    if (files.length) await editor.importFiles(files);
                }),
                iconButton('sliders', 'Compression', (e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    showMenu(compressionMenu(editor), r.left - 220, r.bottom + 4);
                }),
            ),
            this.list,
        );
        // It lists the assets, scripts, shaders and prefabs, and how many objects use them: where objects are does not matter.
        onChanges(editor.store, (hint) => touches(hint, 'nodes', 'design') && this.render());
        editor.store.on('load', () => this.render(true));
        // A file being compressed shows it.
        editor.derived.on('status', () => this.render(true));
        editor.shaders.on('status', () => this.render(true));
        editor.compiler.on('compiled', () => this.render(true));
        this.render(true);
    }

    private async compress(ids: string[]) {
        const n = await this.editor.compressFiles(ids);
        if (!n) toast('Nothing to compress: the file is compressed already, its compression is off, or it would not get smaller.', 'info');
    }

    render(force = false) {
        // Listing a script can compile it, which announces 'compiled' and
        // comes back here: finish this pass, then list again.
        if (this.rendering) {
            this.again = true;
            return;
        }
        this.rendering = true;
        try {
            this.renderList(force);
        } finally {
            this.rendering = false;
        }
        if (this.again) {
            this.again = false;
            this.render(true);
        }
    }

    private renderList(force: boolean) {
        const doc = this.editor.store.doc;
        const assets = doc.assets.filter((a) => a.purpose !== 'design');
        const planning = doc.assets.length - assets.length;
        const { scripts: scriptUses, prefabs: instances } = useCounts(doc);
        const key = [
            doc.prefabs.map((p) => p.id + p.name + (p.useModel ? 'm' : '') + (instances.get(p.id) ?? 0)).join('|'),
            doc.assets.map((a) => a.id + a.name).join('|'),
            doc.scripts.map((s) => s.id + s.name + (scriptUses.get(s.id) ?? 0)).join('|'),
            doc.shaders.map((s) => s.id + s.name + s.kind).join('|'),
        ].join('#');
        if (!force && key === this.key) return;
        this.key = key;
        clear(this.list);
        for (const p of doc.prefabs) {
            const count = instances.get(p.id) ?? 0;
            this.list.appendChild(
                this.item(`prefab:${p.id}`, 'prefab', p.name, `${count} placed`, '', 'Prefab: drag into the viewport or double-click to place an instance', () => this.editor.placePrefab(p.id), [
                    { label: 'Place Instance', icon: 'plus', action: () => this.editor.placePrefab(p.id) },
                    { label: 'Select Instances', enabled: () => count > 0, action: () => this.editor.store.select(this.editor.instancesOf(p.id).map((n) => n.id)) },
                    { label: 'Replace with Model...', icon: 'model', action: () => void this.editor.replacePrefabModel(p.id) },
                    { separator: true },
                    { label: 'Delete Prefab', icon: 'trash', action: () => void this.editor.deletePrefab(p.id) },
                ]),
            );
        }
        if (!assets.length && !doc.scripts.length && !doc.shaders.length && !doc.prefabs.length) {
            this.list.appendChild(
                h('div', { class: 'empty-hint', text: 'Drop .glb / .gltf models, images or sounds onto the viewport, pick from the Library, or use + to write a script or shader.' }),
            );
        }
        for (const a of assets) {
            if (a.kind === 'data') {
                // A terrain's heights or paint: the terrain shows and changes it (Inspector, sculpting).
                this.list.appendChild(
                    this.item(a.id, 'image', a.name, formatBytes(a.size), '', 'Terrain data: its heights or painted layers', () => {}, [
                        { label: 'Remove from Project', icon: 'trash', action: () => this.editor.removeAsset(a.id) },
                    ]),
                );
                continue;
            }
            const packable = (a.kind === 'texture' || a.kind === 'model') && !shipsAsIs(a);
            const size = this.editor.derived.isPacking(a.id) ? 'compressing' : a.packed ? `${formatBytes(a.size)} packed` : formatBytes(a.size);
            const sound = a.kind === 'audio';
            const hint = a.kind === 'model' ? 'Drag into the viewport or double-click to add' : sound ? 'Drag onto an object (or into the scene) to play it from there; double-click to add it to the selection' : 'Drag onto an object or double-click to apply to the selection';
            this.list.appendChild(
                this.item(a.id, a.kind === 'model' ? 'model' : sound ? 'speaker' : 'image', a.name, size, '', hint, () => this.use(a.id), [
                    { label: a.kind === 'model' ? 'Add to Scene' : sound ? 'Play from Selection' : 'Apply to Selection', icon: 'plus', action: () => this.use(a.id) },
                    ...(sound ? [{ label: 'Listen', icon: 'play', action: () => void toggleSound(a).catch((e) => toast(e?.message || String(e), 'error')) }] : []),
                    ...(packable ? [{ label: 'Compress File', icon: 'minimize', action: () => void this.compress([a.id]) }] : []),
                    { label: 'Remove from Project', icon: 'trash', action: () => this.editor.removeAsset(a.id) },
                ]),
            );
        }
        for (const s of doc.scripts) {
            const c = this.editor.compiler.get(s.id);
            const users = scriptUses.get(s.id) ?? 0;
            this.list.appendChild(
                this.item(`script:${s.id}`, 'script', s.name, c?.paused ? 'paused' : users ? `${users} use${users > 1 ? 's' : ''}` : 'script', c?.error && !c.paused ? 'error' : '', 'Double-click to edit, drag onto an object to attach', () => this.editor.emit('open-code', { kind: 'script', id: s.id }), [
                    { label: 'Edit', icon: 'code', action: () => this.editor.emit('open-code', { kind: 'script', id: s.id }) },
                    { label: 'Attach to Selection', icon: 'link', enabled: () => this.editor.store.selection.length > 0, action: () => this.editor.attachScript(this.editor.store.selection, s.id) },
                    { separator: true },
                    { label: 'Delete', icon: 'trash', action: () => void this.editor.deleteScript(s.id) },
                ]),
            );
        }
        for (const s of doc.shaders) {
            const st = this.editor.shaders.status(s.id);
            const kind = s.kind === 'post' ? 'post effect' : s.lighting === 'lit' ? 'lit shader' : 'unlit shader';
            const menu: MenuItem[] = [{ label: 'Edit', icon: 'code', action: () => this.editor.emit('open-code', { kind: 'shader', id: s.id }) }];
            if (s.kind === 'material') menu.push({ label: 'Assign to Selection', icon: 'link', action: () => this.editor.assignShader(this.editor.store.selection, s.id) });
            else menu.push({ label: 'Add to Post Chain', icon: 'graph', action: () => this.editor.addPostEffect(s.id) });
            menu.push({ separator: true }, { label: 'Delete', icon: 'trash', action: () => void this.editor.deleteShader(s.id) });
            this.list.appendChild(
                this.item(`shader:${s.id}`, 'shader', s.name, kind, st.state === 'error' ? 'error' : '', s.kind === 'post' ? 'Double-click to edit, drag onto the viewport to add to the post chain' : 'Double-click to edit, drag onto a mesh to use it', () => this.editor.emit('open-code', { kind: 'shader', id: s.id }), menu),
            );
        }
        if (planning) {
            this.list.appendChild(
                h('div', { class: 'asset-note muted small', text: `${planning} planning file${planning === 1 ? ' (concept, paintover, capture or snapshot) is' : 's (concepts, paintovers, captures, snapshots) are'} in the Design tab.` }),
            );
        }
    }

    private item(dragId: string, iconName: string, name: string, meta: string, state: string, title: string, onOpen: () => void, menu: MenuItem[]): HTMLElement {
        const item = pressable(h(
            'div',
            { class: 'asset-item' + (state ? ' ' + state : ''), title, attrs: { draggable: 'true' } },
            icon(iconName, 15),
            h('span', { class: 'asset-name', text: name }),
            state === 'error' ? h('span', { class: 'tree-badge error', text: 'error' }) : null,
            h('span', { class: 'asset-size', text: meta }),
        ));
        // Enter opens it, as a double click does.
        item.addEventListener('click', (e) => {
            if (e.detail === 0) onOpen();
        });
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer!.setData(ASSET_MIME, dragId);
            e.dataTransfer!.effectAllowed = 'copy';
        });
        item.addEventListener('dblclick', onOpen);
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showMenu(menu, e.clientX, e.clientY);
        });
        return item;
    }

    private use(id: string) {
        const asset = this.editor.store.doc.assets.find((a) => a.id === id);
        if (!asset) return;
        if (asset.kind === 'model') this.editor.addModel(id, undefined, true);
        else if (asset.kind === 'audio') this.editor.store.select(this.editor.addSound(id, this.editor.store.selection));
        else if (asset.kind === 'texture') this.editor.applyTexture(id);
    }
}

/** "New script / shader" entries shared by the assets panel and the Create menu. */
export function createAssetMenu(editor: Editor): MenuItem[] {
    const sel = () => editor.store.selection;
    return [
        {
            label: 'Script',
            icon: 'script',
            submenu: SCRIPT_TEMPLATES.map((t) => ({
                label: t.label,
                action: () => editor.createScript({ name: t.id === 'empty' ? 'NewScript' : t.label.replace(/\s+/g, ''), template: t.id, attachTo: sel() }),
            })),
        },
        {
            label: 'Material Shader',
            icon: 'shader',
            submenu: SHADER_TEMPLATES.filter((t) => t.kind === 'material').map((t) => ({
                label: t.label,
                action: () => {
                    const doc = editor.createShader({ template: t.id });
                    if (sel().some((id) => editor.store.node(id)?.mesh)) editor.assignShader(sel(), doc.id);
                },
            })),
        },
        {
            label: 'Post Effect Shader',
            icon: 'graph',
            submenu: SHADER_TEMPLATES.filter((t) => t.kind === 'post').map((t) => ({
                label: t.label,
                action: () => {
                    const doc = editor.createShader({ template: t.id });
                    editor.addPostEffect(doc.id);
                },
            })),
        },
    ];
}

/** Whether imports are compressed (keeping only the compressed file) and game copies made in the background, and compressing every file now. */
function compressionMenu(editor: Editor): MenuItem[] {
    const store = editor.store;
    return [
        {
            label: 'Compress Imported Files',
            checked: () => store.prefs.compressImports,
            action: () => store.setPrefs({ compressImports: !store.prefs.compressImports }),
        },
        {
            label: 'Make Game Copies in the Background',
            checked: () => store.prefs.backgroundCompression,
            action: () => store.setPrefs({ backgroundCompression: !store.prefs.backgroundCompression }),
        },
        { separator: true },
        {
            label: 'Compress All Files Now',
            icon: 'minimize',
            action: () =>
                void editor.compressFiles().then((n) => toast(n ? `Compressed ${n} file${n === 1 ? '' : 's'}.` : 'Every file is compressed already, or would not get smaller.', 'info')),
        },
    ];
}
