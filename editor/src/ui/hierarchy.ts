import type { Commands } from '../commands';
import type { Editor } from '../editor';
import type { NodeDoc } from '../core/types';
import { onChanges, touches, type FrameChanges } from './batch';
import { clear, h } from './dom';
import { icon, nodeIcon } from './icons';
import { MenuItem, showMenu } from './overlays';
import { iconButton } from './widgets';

type DropZone = 'before' | 'after' | 'inside';

/** A row of the tree: an object shown at `depth`. */
interface Row {
    id: string;
    depth: number;
    kids: boolean;
    open: boolean;
}

/** Rows drawn beyond the visible ones, so scrolling a little shows no gap. */
const OVERSCAN = 8;
/** The tree's padding above the first row (styles.css .tree). */
const PAD_TOP = 2;

/**
 * Scene tree with selection, rename, visibility and drag & drop
 * re-parenting. Only the rows in view are in the page (a scene can have
 * thousands of objects); a new selection only marks rows again.
 */
export class HierarchyPanel {
    readonly el: HTMLElement;
    private tree: HTMLElement;
    /** As tall as every row together, so the tree scrolls as if they were all there. */
    private sizer: HTMLElement;
    /** The rows in view. */
    private list: HTMLElement;
    private banner: HTMLElement;
    private filter = '';
    private collapsed = new Set<string>();
    private anchor: string | null = null;
    private dragIds: string[] = [];
    private renaming: string | null = null;
    /** Ends the rename in progress (applying it or not). */
    private stopRename: ((apply: boolean) => void) | null = null;
    private changes: FrameChanges;

    /** Every row, in order (what the tree would show without scrolling). */
    private rows: Row[] = [];
    private rowOf = new Map<string, number>();
    /** Row elements in the page by object id, with what they show (see stamp). */
    private drawn = new Map<string, { el: HTMLElement; stamp: string }>();
    /** The structure version the rows were made for. */
    private structure = -1;
    private rowHeight = 0;
    private painting = 0;

    constructor(private editor: Editor, private commands: Commands, private createMenu: () => MenuItem[]) {
        const store = editor.store;
        const search = h('input', {
            class: 'search',
            attrs: { type: 'search', placeholder: 'Filter', spellcheck: 'false', 'aria-label': 'Filter objects' },
        });
        search.addEventListener('input', () => {
            this.filter = search.value.trim().toLowerCase();
            this.rebuild();
        });
        search.addEventListener('keydown', (e) => e.stopPropagation());

        this.list = h('div', { class: 'tree-rows' });
        this.sizer = h('div', { class: 'tree-sizer' }, this.list);
        this.tree = h('div', { class: 'tree', attrs: { tabindex: 0, role: 'tree', 'aria-label': 'Scene objects' } }, this.sizer);
        this.banner = h('div', { class: 'isolation-slot' });
        const onRow = (e: Event) => !!(e.target as HTMLElement).closest('.tree-row');
        this.tree.addEventListener('keydown', (e) => this.onKey(e));
        this.tree.addEventListener('scroll', () => this.schedulePaint());
        this.tree.addEventListener('dragover', (e) => {
            if (!this.dragIds.length || onRow(e)) return;
            e.preventDefault();
            this.tree.classList.add('drop-root');
        });
        this.tree.addEventListener('dragleave', () => this.tree.classList.remove('drop-root'));
        this.tree.addEventListener('drop', (e) => {
            this.tree.classList.remove('drop-root');
            if (onRow(e) || !this.dragIds.length) return;
            e.preventDefault();
            editor.moveNodes(this.dragIds, null, null);
            this.dragIds = [];
        });
        this.tree.addEventListener('pointerdown', (e) => {
            if (!onRow(e)) store.select([]);
        });
        this.tree.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!onRow(e)) showMenu(this.createMenu(), e.clientX, e.clientY);
        });
        new ResizeObserver(() => {
            this.rowHeight = 0;
            this.schedulePaint();
        }).observe(this.tree);

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
            this.banner,
            this.tree,
        );

        // Where objects are does not show here.
        this.changes = onChanges(store, (hint) => {
            if (!touches(hint, 'nodes', 'behavior')) return;
            // Names decide what a filter matches.
            if (store.structureVersion !== this.structure || this.filter) this.rebuild();
            else this.paint();
        });
        store.on('selection', () => this.selected());
        editor.on('isolate', () => this.rebuild());
        // A model finished loading: its row loses its badge (see stamp).
        editor.sync.on('model', () => this.paint());
        this.rebuild();
    }

    // --------------------------------------------------------------- rows

    /** Works out the rows again (the objects, the open branches, the filter), then draws them. */
    private rebuild() {
        const store = this.editor.store;
        this.structure = store.structureVersion;
        const rows: Row[] = [];
        const matches = this.filter ? this.filterMatches() : null;
        const isolated = this.editor.isolated;
        const walk = (parent: string | null, depth: number) => {
            for (const node of store.children(parent)) {
                if (matches && !matches.has(node.id)) continue;
                if (isolated && depth === 0 && node.id !== isolated) continue;
                const kids = store.children(node.id).length > 0;
                const open = !this.collapsed.has(node.id) || !!matches;
                rows.push({ id: node.id, depth, kids, open });
                if (kids && open) walk(node.id, depth + 1);
            }
        };
        const root = isolated ? store.node(isolated) : undefined;
        if (root) {
            rows.push({ id: root.id, depth: 0, kids: store.children(root.id).length > 0, open: true });
            walk(root.id, 1);
        } else walk(null, 0);
        this.rows = rows;
        this.rowOf = new Map(rows.map((r, i) => [r.id, i]));
        clear(this.banner);
        if (root) this.banner.appendChild(this.isolationBanner(root));
        this.paint();
    }

    private schedulePaint() {
        this.painting ||= requestAnimationFrame(() => this.paint());
    }

    /** Puts the rows in view into the page: rows that show the same as before stay as they are. */
    private paint() {
        cancelAnimationFrame(this.painting);
        this.painting = 0;
        const store = this.editor.store;
        if (!store.doc.nodes.length) {
            this.drawn.clear();
            this.sizer.style.height = '';
            this.list.style.transform = '';
            this.list.replaceChildren(h('div', { class: 'empty-hint', text: 'The scene is empty. Use + or the Create menu to add objects.' }));
            return;
        }
        const height = this.measure();
        this.sizer.style.height = `${this.rows.length * height}px`;
        const view = this.tree.clientHeight || 600;
        const first = Math.max(0, Math.floor((this.tree.scrollTop - PAD_TOP) / height) - OVERSCAN);
        const last = Math.min(this.rows.length, Math.ceil((this.tree.scrollTop + view) / height) + OVERSCAN);
        this.list.style.transform = `translateY(${first * height}px)`;
        // A row being renamed that scrolls away takes the name typed so far.
        const renamed = this.renaming ? this.rowOf.get(this.renaming) : undefined;
        if (this.renaming && (renamed === undefined || renamed < first || renamed >= last)) queueMicrotask(() => this.stopRename?.(true));

        const selected = new Set(store.selection);
        const primary = store.primary?.id;
        const drawn = new Map<string, { el: HTMLElement; stamp: string }>();
        const els: HTMLElement[] = [];
        for (let i = first; i < last; i++) {
            const row = this.rows[i];
            const node = store.node(row.id);
            if (!node) continue;
            const stamp = this.stamp(node, row);
            let item = this.drawn.get(row.id);
            // The row being renamed keeps its input.
            if (!item || (item.stamp !== stamp && row.id !== this.renaming)) item = { el: this.row(node, row), stamp };
            this.mark(item.el, node.id, selected, primary);
            drawn.set(row.id, item);
            els.push(item.el);
        }
        this.drawn = drawn;
        // Only moves what changed: a row keeps its hover and focus.
        const current = Array.from(this.list.children);
        if (current.length !== els.length || els.some((el, i) => current[i] !== el)) this.list.replaceChildren(...els);
    }

    /** Height of a row, from the first one drawn (taller on touch screens). */
    private measure(): number {
        if (this.rowHeight) return this.rowHeight;
        const sample = this.list.querySelector<HTMLElement>('.tree-row');
        const height = sample?.offsetHeight ?? 0;
        if (height) this.rowHeight = height;
        return height || (matchMedia('(pointer: coarse)').matches ? 34 : 26);
    }

    /** What a row shows besides the selection: when it is the same, the drawn row stays. */
    private stamp(node: NodeDoc, row: Row): string {
        const store = this.editor.store;
        const model = node.model ? this.editor.sync.modelState(node.id)?.status ?? '' : '';
        // An agent's mark names its tree (the behavior part of the document).
        const agent = node.agent ? store.partsVersion : '';
        return `${store.nodeVersion(node.id)}|${row.depth}|${row.kids ? 1 : 0}${row.open ? 1 : 0}|${model}|${agent}|${this.editor.isolated ? 1 : 0}`;
    }

    private mark(el: HTMLElement, id: string, selected: Set<string>, primary: string | undefined) {
        const on = selected.has(id);
        el.classList.toggle('selected', on);
        el.classList.toggle('primary', id === primary);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
    }

    /** A new selection marks the rows in view and shows the primary object's row (opening its parents). */
    private selected() {
        const store = this.editor.store;
        this.changes.flush();
        if (this.reveal(store.primary?.id)) return;
        const selected = new Set(store.selection);
        const primary = store.primary?.id;
        for (const [id, item] of this.drawn) this.mark(item.el, id, selected, primary);
    }

    /**
     * Shows an object's row: its parents open, scrolled into view. True when
     * that drew the rows again.
     */
    private reveal(id: string | undefined): boolean {
        if (!id) return false;
        const store = this.editor.store;
        let opened = false;
        for (let n = store.node(store.node(id)?.parent); n; n = store.node(n.parent)) opened = this.collapsed.delete(n.id) || opened;
        if (opened) this.rebuild();
        const i = this.rowOf.get(id);
        if (i === undefined) return opened;
        const height = this.measure();
        const top = PAD_TOP + i * height;
        const tree = this.tree;
        let scroll = tree.scrollTop;
        if (top < scroll) scroll = top;
        else if (top + height > scroll + tree.clientHeight) scroll = top + height - tree.clientHeight;
        if (scroll === tree.scrollTop) return opened;
        tree.scrollTop = scroll;
        this.paint();
        return true;
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
            while (cur && !out.has(cur.id)) {
                out.add(cur.id);
                cur = store.node(cur.parent);
            }
        }
        return out;
    }

    /** Rows in visual order, for shift-click ranges and keyboard navigation (also those not in view). */
    private visibleIds(): string[] {
        return this.rows.map((r) => r.id);
    }

    /** Objects that run a behavior tree; a click shows the tree. */
    private agentMark(node: NodeDoc): HTMLElement {
        const agent = node.agent!;
        const tree = this.editor.store.doc.behaviors.find((t) => t.id === agent.tree);
        const title = tree ? `Runs the behavior tree ${tree.name}${agent.enabled ? '' : ' (disabled)'}` : `Its behavior tree "${agent.tree}" is missing`;
        const mark = h('span', { class: 'tree-agent' + (agent.enabled ? '' : ' off') + (tree ? '' : ' error'), title }, icon('agent', 13));
        mark.addEventListener('pointerdown', (e) => e.stopPropagation());
        mark.addEventListener('click', (e) => {
            e.stopPropagation();
            this.editor.showBehavior({ tree: agent.tree });
        });
        return mark;
    }

    private row(node: NodeDoc, { depth, kids: hasKids, open }: Row): HTMLElement {
        const editor = this.editor;
        const store = editor.store;
        const status = node.model ? editor.sync.modelState(node.id)?.status : null;
        const caret = h('span', { class: 'tree-caret' + (hasKids ? '' : ' leaf') + (open ? ' open' : '') }, hasKids ? icon('chevron', 12) : null);
        caret.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!hasKids) return;
            if (this.collapsed.has(node.id)) this.collapsed.delete(node.id);
            else this.collapsed.add(node.id);
            this.rebuild();
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
                class: 'tree-row' + (node.visible ? '' : ' hidden-node') + (locked ? ' prefab-part' : ''),
                attrs: { draggable: 'true', role: 'treeitem', 'aria-level': depth + 1, ...(hasKids ? { 'aria-expanded': open ? 'true' : 'false' } : {}) },
                dataset: { id: node.id },
                style: { paddingLeft: 6 + depth * 14 + 'px' },
            },
            caret,
            h('span', { class: 'tree-icon ' + nodeIcon(node) }, icon(nodeIcon(node), 15)),
            name,
            status === 'loading' ? h('span', { class: 'tree-badge', text: 'loading' }) : null,
            status === 'error' ? h('span', { class: 'tree-badge error', text: 'missing' }) : null,
            node.agent ? this.agentMark(node) : null,
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
                const next = siblings[siblings.findIndex((n) => n.id === node.id) + 1];
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
        this.changes.flush();
        this.reveal(id);
        const row = this.drawn.get(id)?.el;
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
            this.stopRename = null;
            // The row shows the name again, the new one or the old.
            this.drawn.delete(id);
            if (apply && input.value.trim() && input.value !== node.name) this.editor.rename(id, input.value);
            this.changes.flush();
            this.paint();
            this.tree.focus({ preventScroll: true });
        };
        this.stopRename = finish;
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
        const cmd = (id: string, patch?: Partial<MenuItem>) => this.commands.item(id, patch);
        return [
            cmd('edit.rename', { icon: 'dots', action: () => this.startRename(node.id) }),
            cmd('edit.duplicate'),
            cmd('edit.delete'),
            { separator: true },
            cmd('view.frame', { label: 'Frame' }),
            cmd('edit.hide', { label: node.visible ? 'Hide' : 'Show', icon: node.visible ? 'eyeOff' : 'eye' }),
            cmd('edit.group', { label: 'Group Selection' }),
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
            this.rebuild();
        } else if (e.key === 'F2' && cur) {
            e.preventDefault();
            e.stopPropagation();
            this.startRename(cur);
        }
    }
}
