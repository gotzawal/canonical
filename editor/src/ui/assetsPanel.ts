import type { Editor } from '../editor';
import { formatBytes } from '../core/assets';
import { pickFiles } from '../core/persistence';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES } from '../core/templates';
import { clear, h } from './dom';
import { icon } from './icons';
import { MenuItem, showMenu } from './overlays';
import { iconButton } from './widgets';

/** Payload of dragged assets: an asset id, or "script:<id>" / "shader:<id>". */
export const ASSET_MIME = 'application/x-canonical-asset';

/** Imported models and textures, plus the project's scripts and shaders. */
export class AssetsPanel {
    readonly el: HTMLElement;
    private list: HTMLElement;
    private key = '';

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
                iconButton('upload', 'Import model or image', async () => {
                    const files = await pickFiles('.glb,.gltf,image/*', true);
                    if (files.length) await editor.importFiles(files);
                }),
            ),
            this.list,
        );
        editor.store.on('change', () => this.render());
        editor.store.on('load', () => this.render(true));
        editor.shaders.on('status', () => this.render(true));
        editor.compiler.on('compiled', () => this.render(true));
        this.render(true);
    }

    render(force = false) {
        const doc = this.editor.store.doc;
        const assets = doc.assets.filter((a) => a.purpose !== 'design');
        const planning = doc.assets.length - assets.length;
        const key = [
            doc.prefabs.map((p) => p.id + p.name + (p.useModel ? 'm' : '') + doc.nodes.filter((n) => n.prefab === p.id).length).join('|'),
            doc.assets.map((a) => a.id + a.name).join('|'),
            doc.scripts.map((s) => s.id + s.name).join('|'),
            doc.shaders.map((s) => s.id + s.name + s.kind).join('|'),
        ].join('#');
        if (!force && key === this.key) return;
        this.key = key;
        clear(this.list);
        for (const p of doc.prefabs) {
            const count = doc.nodes.filter((n) => n.prefab === p.id).length;
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
                h('div', { class: 'empty-hint', text: 'Drop .glb / .gltf models or images onto the viewport, or use + to write a script or shader.' }),
            );
        }
        for (const a of assets) {
            this.list.appendChild(
                this.item(a.id, a.kind === 'model' ? 'model' : 'image', a.name, formatBytes(a.size), '', a.kind === 'model' ? 'Drag into the viewport or double-click to add' : 'Drag onto an object or double-click to apply to the selection', () => this.use(a.id), [
                    { label: a.kind === 'model' ? 'Add to Scene' : 'Apply to Selection', icon: 'plus', action: () => this.use(a.id) },
                    { label: 'Remove from Project', icon: 'trash', action: () => this.editor.removeAsset(a.id) },
                ]),
            );
        }
        for (const s of doc.scripts) {
            const c = this.editor.compiler.get(s.id);
            const users = doc.nodes.filter((n) => n.scripts?.some((r) => r.script === s.id)).length;
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
        const item = h(
            'div',
            { class: 'asset-item' + (state ? ' ' + state : ''), title, attrs: { draggable: 'true' } },
            icon(iconName, 15),
            h('span', { class: 'asset-name', text: name }),
            state === 'error' ? h('span', { class: 'tree-badge error', text: 'error' }) : null,
            h('span', { class: 'asset-size', text: meta }),
        );
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
        else this.editor.applyTexture(id);
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
