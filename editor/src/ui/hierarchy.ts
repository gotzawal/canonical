import type { Editor } from '../editor';
import type { NodeDoc } from '../core/types';
import { clear, h } from './dom';
import { icon, nodeIcon } from './icons';
import { MenuItem, showMenu } from './overlays';
import { iconButton } from './widgets';

type DropZone = 'before' | 'after' | 'inside';

/** Scene tree with selection, rename, visibility and drag & drop re-parenting. */
export class HierarchyPanel {
    readonly el: HTMLElement;
    private tree: HTMLElement;
    private filter = '';
    private collapsed = new Set<string>();
    private key = '';
    private anchor: string | null = null;
    private dragIds: string[] = [];
    private renaming: string | null = null;

    constructor(private editor: Editor, private createMenu: () => MenuItem[]) {
        const store = editor.store;
        const search = h('input', {
            class: 'search',
            attrs: { type: 'search', placeholder: 'Filter', spellcheck: 'false', 'aria-label': 'Filter objects' },
        });
        search.addEventListener('input', () => {
            this.filter = search.value.trim().toLowerCase();
            this.render(true);
        });
        search.addEventListener('keydown', (e) => e.stopPropagation());

        this.tree = h('div', { class: 'tree', attrs: { tabindex: 0, role: 'tree', 'aria-label': 'Scene objects' } });
        this.tree.addEventListener('keydown', (e) => this.onKey(e));
        this.tree.addEventListener('dragover', (e) => {
            if (!this.dragIds.length) return;
            if (e.target === this.tree) {
                e.preventDefault();
                this.tree.classList.add('drop-root');
            }
        });
        this.tree.addEventListener('dragleave', () => this.tree.classList.remove('drop-root'));
        this.tree.addEventListener('drop', (e) => {
            this.tree.classList.remove('drop-root');
            if (e.target !== this.tree || !this.dragIds.length) return;
            e.preventDefault();
            editor.moveNodes(this.dragIds, null, null);
            this.dragIds = [];
        });
        this.tree.addEventListener('pointerdown', (e) => {
            if (e.target === this.tree) store.select([]);
        });
        this.tree.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (e.target === this.tree) showMenu(this.createMenu(), e.clientX, e.clientY);
        });

        this.el = h(
            'div',
            { class: 'panel hierarchy' },
            h(
                'div',
                { class: 'panel-header' },
                icon('layers', 15),
                h('span', { class: 'panel-title', text: 'Hierarchy' }),
                h('div', { class: 'spacer' }),
                iconButton('plus', 'Create object', (e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    showMenu(this.createMenu(), r.left, r.bottom + 4);
                }),
            ),
            h('div', { class: 'panel-search' }, icon('search', 14), search),
            this.tree,
        );

        store.on('change', () => this.render());
        store.on('selection', () => this.render(true));
        editor.on('isolate', () => this.render(true));
        editor.sync.on('model', () => this.render(true));
        this.render(true);
    }

    private treeKey(): string {
        return (
            (this.editor.isolated ?? '') +
            this.editor.store.doc.nodes.map((n) => `${n.id}:${n.parent}:${n.name}:${n.visible ? 1 : 0}:${nodeIcon(n)}:${n.prefabChild ? 1 : 0}`).join('|')
        );
    }

    render(force = false) {
        const key = this.treeKey();
        if (!force && key === this.key) return;
        this.key = key;
        if (this.renaming) return;
        const store = this.editor.store;
        const scroll = this.tree.scrollTop;
        clear(this.tree);
        const selected = new Set(store.selection);
        const matches = this.filter ? this.filterMatches() : null;

        const isolated = this.editor.isolated;
        const walk = (parent: string | null, depth: number) => {
            for (const node of store.children(parent)) {
                if (matches && !matches.has(node.id)) continue;
                if (isolated && depth === 0 && node.id !== isolated) continue;
                const kids = store.children(node.id);
                const open = !this.collapsed.has(node.id) || !!matches;
                this.tree.appendChild(this.row(node, depth, kids.length > 0, open, selected.has(node.id)));
                if (kids.length && open) walk(node.id, depth + 1);
            }
        };
        if (isolated && store.node(isolated)) {
            const root = store.node(isolated)!;
            this.tree.appendChild(this.isolationBanner(root));
            this.tree.appendChild(this.row(root, 0, store.children(root.id).length > 0, true, selected.has(root.id)));
            walk(root.id, 1);
        } else walk(null, 0);
        if (!store.doc.nodes.length) {
            this.tree.appendChild(h('div', { class: 'empty-hint', text: 'The scene is empty. Use + or the Create menu to add objects.' }));
        }
        this.tree.scrollTop = scroll;
    }

    private isolationBanner(root: NodeDoc): HTMLElement {
        const editor = this.editor;
        const prefab = editor.prefab(root.prefab);
        const count = prefab ? editor.instancesOf(prefab.id).length : 0;
        return h(
            'div',
            { class: 'isolation-banner' },
            h('div', { class: 'isolation-title' }, icon('prefab', 14), h('span', { text: `Editing prefab ${prefab?.name ?? ''}` })),
            h('div', { class: 'muted small', text: `Everything else is hidden. Apply updates all ${count} instance${count === 1 ? '' : 's'}.` }),
            h(
                'div',
                { class: 'inline' },
                h('button', { class: 'btn small primary', text: 'Apply to All', attrs: { type: 'button' }, on: { click: () => editor.finishPrefabEdit(true) } }),
                h('button', { class: 'btn small', text: 'Discard', attrs: { type: 'button' }, on: { click: () => editor.finishPrefabEdit(false) } }),
            ),
        );
    }

    /** Ids of nodes matching the filter plus their ancestors. */
    private filterMatches(): Set<string> {
        const store = this.editor.store;
        const out = new Set<string>();
        for (const n of store.doc.nodes) {
            if (!n.name.toLowerCase().includes(this.filter)) continue;
            let cur: NodeDoc | undefined = n;
            while (cur) {
                out.add(cur.id);
                cur = store.node(cur.parent);
            }
        }
        return out;
    }

    /** Rows in visual order, for shift-click ranges and keyboard navigation. */
    private visibleIds(): string[] {
        return Array.from(this.tree.querySelectorAll<HTMLElement>('.tree-row')).map((r) => r.dataset.id!);
    }

    private row(node: NodeDoc, depth: number, hasKids: boolean, open: boolean, selected: boolean): HTMLElement {
        const editor = this.editor;
        const store = editor.store;
        const status = node.model ? editor.sync.modelState(node.id)?.status : null;
        const caret = h('span', { class: 'tree-caret' + (hasKids ? '' : ' leaf') + (open ? ' open' : '') }, hasKids ? icon('chevron', 12) : null);
        caret.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!hasKids) return;
            if (this.collapsed.has(node.id)) this.collapsed.delete(node.id);
            else this.collapsed.add(node.id);
            this.render(true);
        });
        const eye = h(
            'button',
            {
                class: 'tree-eye' + (node.visible ? '' : ' off'),
                title: node.visible ? 'Hide' : 'Show',
                attrs: { type: 'button', 'aria-label': node.visible ? 'Hide' : 'Show' },
            },
            icon(node.visible ? 'eye' : 'eyeOff', 14),
        );
        eye.addEventListener('pointerdown', (e) => e.stopPropagation());
        eye.addEventListener('click', (e) => {
            e.stopPropagation();
            const ids = store.selection.includes(node.id) ? store.selection : [node.id];
            editor.toggleVisibility(ids);
        });
        const name = h('span', { class: 'tree-name', text: node.name || '(unnamed)' });
        const locked = !!node.prefabChild && !editor.isolated;
        const row = h(
            'div',
            {
                class: 'tree-row' + (selected ? ' selected' : '') + (node.visible ? '' : ' hidden-node') + (store.primary?.id === node.id ? ' primary' : '') + (locked ? ' prefab-part' : ''),
                attrs: { draggable: 'true', role: 'treeitem', 'aria-selected': selected ? 'true' : 'false' },
                dataset: { id: node.id },
                style: { paddingLeft: 6 + depth * 14 + 'px' },
            },
            caret,
            h('span', { class: 'tree-icon ' + nodeIcon(node) }, icon(nodeIcon(node), 15)),
            name,
            status === 'loading' ? h('span', { class: 'tree-badge', text: 'loading' }) : null,
            status === 'error' ? h('span', { class: 'tree-badge error', text: 'missing' }) : null,
            eye,
        );

        row.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            this.tree.focus({ preventScroll: true });
            if (e.shiftKey && this.anchor) {
                const ids = this.visibleIds();
                const a = ids.indexOf(this.anchor), b = ids.indexOf(node.id);
                if (a >= 0 && b >= 0) {
                    const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
                    if (a > b) range.reverse();
                    store.select(range.filter((id) => id !== node.id).concat(node.id));
                    return;
                }
            }
            const id = editor.selectable(node.id);
            if (e.ctrlKey || e.metaKey) {
                store.select([id], 'toggle');
            } else if (!store.selection.includes(id)) {
                store.select([id]);
            }
            this.anchor = id;
        });
        row.addEventListener('click', (e) => {
            // Plain click on an already selected row narrows a multi-selection.
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey && store.selection.length > 1) store.select([node.id]);
        });
        row.addEventListener('dblclick', (e) => {
            if ((e.target as HTMLElement).closest('.tree-name')) this.startRename(node.id);
            else editor.viewport.frameNodes([node.id]);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!store.selection.includes(node.id)) store.select([node.id]);
            showMenu(this.nodeMenu(node), e.clientX, e.clientY);
        });

        row.addEventListener('dragstart', (e) => {
            if (locked) {
                e.preventDefault();
                return;
            }
            this.dragIds = store.selection.includes(node.id) ? store.selectionRoots() : [node.id];
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('text/plain', node.name);
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            this.dragIds = [];
            this.clearDropMarks();
        });
        row.addEventListener('dragover', (e) => {
            if (!this.dragIds.length) return;
            const zone = this.zone(e, row);
            const invalid = this.dragIds.includes(node.id) || this.dragIds.some((id) => store.isAncestor(id, node.id));
            if (invalid) return;
            e.preventDefault();
            e.stopPropagation();
            this.clearDropMarks();
            row.classList.add('drop-' + zone);
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
        row.addEventListener('drop', (e) => {
            if (!this.dragIds.length) return;
            e.preventDefault();
            e.stopPropagation();
            const zone = this.zone(e, row);
            this.clearDropMarks();
            const ids = this.dragIds;
            this.dragIds = [];
            if (zone === 'inside') {
                this.collapsed.delete(node.id);
                editor.moveNodes(ids, node.id, null);
            } else if (zone === 'before') {
                editor.moveNodes(ids, node.parent, node.id);
            } else {
                const siblings = store.children(node.parent);
                const next = siblings[siblings.indexOf(node) + 1];
                editor.moveNodes(ids, node.parent, next ? next.id : null);
            }
        });
        return row;
    }

    private zone(e: DragEvent, row: HTMLElement): DropZone {
        const r = row.getBoundingClientRect();
        const t = (e.clientY - r.top) / r.height;
        return t < 0.28 ? 'before' : t > 0.72 ? 'after' : 'inside';
    }

    private clearDropMarks() {
        this.tree.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
        this.tree.classList.remove('drop-root');
    }

    startRename(id: string) {
        const row = this.tree.querySelector<HTMLElement>(`.tree-row[data-id="${CSS.escape(id)}"]`);
        const node = this.editor.store.node(id);
        if (!row || !node) return;
        const nameEl = row.querySelector('.tree-name') as HTMLElement;
        const input = h('input', { class: 'tree-rename', attrs: { type: 'text', spellcheck: 'false' } });
        input.value = node.name;
        this.renaming = id;
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (apply: boolean) => {
            if (done) return;
            done = true;
            this.renaming = null;
            if (apply && input.value.trim() && input.value !== node.name) this.editor.rename(id, input.value);
            this.render(true);
            this.tree.focus({ preventScroll: true });
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    private nodeMenu(node: NodeDoc): MenuItem[] {
        const editor = this.editor;
        const prefab = node.prefab ? editor.prefab(node.prefab) : undefined;
        const prefabItems: MenuItem[] = prefab
            ? [
                  { separator: true },
                  { label: 'Edit Prefab', icon: 'prefab', enabled: () => !editor.isolated && !prefab.useModel, action: () => editor.editPrefab(node.id) },
                  { label: 'Select All Instances', action: () => editor.store.select(editor.instancesOf(prefab.id).map((n) => n.id)) },
                  { label: 'Unpack Instance', action: () => editor.unpackInstance(node.id) },
              ]
            : [
                  { separator: true },
                  { label: 'Make Prefab', icon: 'prefab', enabled: () => !node.prefabChild, action: () => editor.createPrefab() },
              ];
        return [
            { label: 'Rename', icon: 'dots', shortcut: 'F2', action: () => this.startRename(node.id) },
            { label: 'Duplicate', icon: 'copy', shortcut: 'Mod+D', action: () => editor.duplicateSelection() },
            { label: 'Delete', icon: 'trash', shortcut: 'Del', action: () => editor.deleteSelection() },
            { separator: true },
            { label: 'Frame', icon: 'focus', shortcut: 'F', action: () => editor.viewport.frameNodes(editor.store.selection) },
            { label: node.visible ? 'Hide' : 'Show', icon: node.visible ? 'eyeOff' : 'eye', shortcut: 'H', action: () => editor.toggleVisibility(editor.store.selection) },
            { label: 'Group Selection', icon: 'layers', shortcut: 'Mod+G', action: () => editor.groupSelection() },
            { label: 'Create Child Empty', icon: 'empty', action: () => editor.createEmpty(node.id) },
            { separator: true },
            { label: 'Move to Root', icon: 'home', enabled: () => !!node.parent, action: () => editor.moveNodes(editor.store.selectionRoots(), null, null) },
            ...prefabItems,
        ];
    }

    private onKey(e: KeyboardEvent) {
        const store = this.editor.store;
        const ids = this.visibleIds();
        const cur = store.primary?.id;
        const i = cur ? ids.indexOf(cur) : -1;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) {
                store.select([next]);
                this.anchor = next;
                this.tree.querySelector(`.tree-row[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
            }
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'ArrowLeft') {
                if (store.children(cur).length && !this.collapsed.has(cur)) this.collapsed.add(cur);
                else {
                    const parent = store.node(cur)?.parent;
                    if (parent) store.select([parent]);
                }
            } else this.collapsed.delete(cur);
            this.render(true);
        } else if (e.key === 'F2' && cur) {
            e.preventDefault();
            e.stopPropagation();
            this.startRename(cur);
        }
    }
}
