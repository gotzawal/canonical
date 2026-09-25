import type { Editor } from '../editor';
import { formatBytes } from '../core/assets';
import { clear, h } from './dom';
import { icon } from './icons';
import { showMenu } from './overlays';
import { iconButton } from './widgets';

/** Imported models and textures of the project. */
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
                iconButton('upload', 'Import model or image', async () => {
                    const { pickFiles } = await import('../core/persistence');
                    const files = await pickFiles('.glb,.gltf,image/*', true);
                    if (files.length) await editor.importFiles(files);
                }),
            ),
            this.list,
        );
        editor.store.on('change', () => this.render());
        editor.store.on('load', () => this.render(true));
        this.render(true);
    }

    render(force = false) {
        const assets = this.editor.store.doc.assets;
        const key = assets.map((a) => a.id + a.name).join('|');
        if (!force && key === this.key) return;
        this.key = key;
        clear(this.list);
        if (!assets.length) {
            this.list.appendChild(
                h('div', { class: 'empty-hint', text: 'Drop .glb / .gltf models or images onto the viewport, or use the import button.' }),
            );
            return;
        }
        for (const a of assets) {
            const item = h(
                'div',
                {
                    class: 'asset-item',
                    title: a.kind === 'model' ? 'Drag into the viewport or double-click to add' : 'Drag onto the viewport or double-click to apply to the selection',
                    attrs: { draggable: 'true' },
                },
                icon(a.kind === 'model' ? 'model' : 'image', 15),
                h('span', { class: 'asset-name', text: a.name }),
                h('span', { class: 'asset-size', text: formatBytes(a.size) }),
            );
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer!.setData('application/x-canonical-asset', a.id);
                e.dataTransfer!.effectAllowed = 'copy';
            });
            item.addEventListener('dblclick', () => this.use(a.id));
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showMenu(
                    [
                        { label: a.kind === 'model' ? 'Add to Scene' : 'Apply to Selection', icon: 'plus', action: () => this.use(a.id) },
                        { label: 'Remove from Project', icon: 'trash', action: () => this.editor.removeAsset(a.id) },
                    ],
                    e.clientX,
                    e.clientY,
                );
            });
            this.list.appendChild(item);
        }
    }

    private use(id: string) {
        const asset = this.editor.store.doc.assets.find((a) => a.id === id);
        if (!asset) return;
        if (asset.kind === 'model') this.editor.addModel(id, undefined, true);
        else this.editor.applyTexture(id);
    }
}
