// The behavior tree outliner: the tree as an indented list, like the
// hierarchy panel (drag and drop to reorder and reparent, a context menu to
// add, wrap, duplicate and delete, multi-selection). Decorators and services
// are tags on their node's row; problems mark the row. While playing it
// shows the active path of the chosen agent instead of being edited.

import { findNode, isCompositeDoc, walkNodes } from '../../core/behavior/format';
import { decoratorType, DECORATOR_TYPES, NODE_TYPES, nodeType, serviceType, SERVICE_TYPES } from '../../core/behavior/nodeTypes';
import type { BehaviorOp } from '../../core/behavior/ops';
import type { Issue } from '../../core/behavior/validate';
import type { BehaviorTreeDoc, BlackboardSchemaDoc, BtNodeDoc } from '../../core/types';
import type { TreeDebug } from '../../play/ai/tree';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { showMenu, type MenuItem } from '../overlays';

type DropZone = 'before' | 'after' | 'inside';

/** A part of a node the properties panel opens: a decorator (by index) or a service (by id). */
export type FocusPart = { kind: 'decorator'; index: number } | { kind: 'service'; id: string } | null;

export interface OutlinerHost {
    tree(): BehaviorTreeDoc | undefined;
    schema(): BlackboardSchemaDoc | undefined;
    issues(): Issue[];
    /** Play mode: the chosen agent's state (null when stopped). */
    debug(): TreeDebug | null;
    locked(): boolean;
    /** Applies operations to the selected tree; returns the created node ids, or null when refused. */
    apply(ops: BehaviorOp[], label: string): string[] | null;
    /** Selection changed (node ids, primary last), with the part to open. */
    selected(ids: string[], part: FocusPart): void;
}

export class Outliner {
    readonly el: HTMLElement;
    selection: string[] = [];
    private collapsed = new Set<string>();
    private anchor: string | null = null;
    private dragIds: string[] = [];
    private renaming: string | null = null;
    private key = '';

    constructor(private host: OutlinerHost) {
        this.el = h('div', { class: 'tree bt-outliner', attrs: { tabindex: 0, role: 'tree', 'aria-label': 'Behavior tree' } });
        this.el.addEventListener('keydown', (e) => this.onKey(e));
        this.el.addEventListener('pointerdown', (e) => {
            if (e.target === this.el) this.select([]);
        });
    }

    get primary(): string | null {
        return this.selection[this.selection.length - 1] ?? null;
    }

    select(ids: string[], part: FocusPart = null) {
        this.selection = ids;
        this.host.selected(ids, part);
        this.render(true);
    }

    /** Keeps the selection to nodes that still exist (after undo or a batch), under their new ids when renamed. */
    prune(renamed?: Map<string, string>) {
        const tree = this.host.tree();
        this.selection = this.selection.map((id) => renamed?.get(id) ?? id);
        const keep = this.selection.filter((id) => tree && findNode(tree, id));
        if (keep.length !== this.selection.length) this.select(keep);
    }

    private structureKey(): string {
        const tree = this.host.tree();
        const dbg = this.host.debug();
        return JSON.stringify([tree?.id, tree?.version, tree?.root, this.host.schema()?.version, this.selection, [...this.collapsed], this.host.issues().map((i) => i.node + i.severity), dbg && [dbg.active, dbg.running, Object.entries(dbg.last).map(([k, v]) => k + v.status + v.at)], this.host.locked()]);
    }

    render(force = false) {
        const key = this.structureKey();
        if (!force && key === this.key) return;
        this.key = key;
        if (this.renaming) return;
        const tree = this.host.tree();
        const scroll = this.el.scrollTop;
        clear(this.el);
        if (!tree) {
            this.el.appendChild(h('div', { class: 'empty-hint', text: 'No behavior tree. Create one with + above, or ask the assistant.' }));
            return;
        }
        const issues = this.host.issues();
        const dbg = this.host.debug();
        const active = new Set(dbg?.active ?? []);
        const selected = new Set(this.selection);
        const keys = (name: string) => this.host.schema()?.keys.find((k) => k.name === name);
        const visit = (n: BtNodeDoc, depth: number, parent: BtNodeDoc | null) => {
            const kids = isCompositeDoc(n) ? n.children : [];
            const open = !this.collapsed.has(n.id);
            this.el.appendChild(this.row(tree, n, parent, depth, kids.length > 0, open, selected.has(n.id), issues, active, dbg, keys));
            if (open) for (const c of kids) visit(c, depth + 1, n);
        };
        visit(tree.root, 0, null);
        this.el.scrollTop = scroll;
    }

    private row(
        tree: BehaviorTreeDoc,
        n: BtNodeDoc,
        parent: BtNodeDoc | null,
        depth: number,
        hasKids: boolean,
        open: boolean,
        selected: boolean,
        issues: Issue[],
        active: Set<string>,
        dbg: TreeDebug | null,
        keys: (name: string) => any,
    ): HTMLElement {
        const def = nodeType(n.type);
        const mine = issues.filter((i) => i.node === n.id || n.services?.some((s) => s.id === i.node));
        const errors = mine.filter((i) => i.severity === 'error');
        const caret = h('span', { class: 'tree-caret' + (hasKids ? '' : ' leaf') + (open ? ' open' : '') }, hasKids ? icon('chevron', 12) : null);
        caret.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!hasKids) return;
            if (this.collapsed.has(n.id)) this.collapsed.delete(n.id);
            else this.collapsed.add(n.id);
            this.render(true);
        });
        const tags = h('span', { class: 'bt-tags' });
        (n.decorators ?? []).forEach((d, i) => {
            const t = h('span', { class: 'bt-tag deco', title: decoratorType(d.type)?.summary ?? d.type }, icon(decoratorType(d.type)?.icon ?? 'filter', 11), h('span', { text: decoratorType(d.type)?.brief(d, keys) ?? d.type }));
            t.addEventListener('click', (e) => {
                e.stopPropagation();
                this.select([n.id], { kind: 'decorator', index: i });
            });
            tags.appendChild(t);
        });
        for (const s of n.services ?? []) {
            const on = active.has(s.id);
            const t = h('span', { class: 'bt-tag service' + (on ? ' active' : ''), title: serviceType(s.type)?.brief(s, keys) ?? s.type }, icon(serviceType(s.type)?.icon ?? 'dots', 11), h('span', { text: s.id }));
            t.addEventListener('click', (e) => {
                e.stopPropagation();
                this.select([n.id], { kind: 'service', id: s.id });
            });
            tags.appendChild(t);
        }
        const last = dbg?.last[n.id];
        const running = !!dbg?.running.includes(n.id);
        const cls = [
            'tree-row',
            'bt-row',
            selected ? 'selected' : '',
            this.primary === n.id ? 'primary' : '',
            active.has(n.id) ? 'active' : '',
            running ? 'running' : '',
            errors.length ? 'has-error' : mine.length ? 'has-warning' : '',
        ].filter(Boolean);
        const mark = mine.length
            ? h('span', { class: 'bt-mark ' + (errors.length ? 'error' : 'warning'), title: mine.map((i) => `${i.severity}: ${i.field ? i.field + ': ' : ''}${i.message}`).join('\n') }, icon('alert', 12))
            : null;
        const status = dbg && last && !active.has(n.id)
            ? h('span', { class: 'bt-last ' + last.status, title: `${last.status} at ${last.at.toFixed(1)}s` }, icon(last.status === 'success' ? 'check' : last.status === 'failure' ? 'close' : 'stop', 11))
            : null;
        const brief = def?.brief(n, keys) ?? '';
        const row = h(
            'div',
            {
                class: cls.join(' '),
                attrs: { draggable: this.host.locked() || !parent ? 'false' : 'true', role: 'treeitem', 'aria-selected': selected ? 'true' : 'false' },
                dataset: { id: n.id },
                style: { paddingLeft: 6 + depth * 16 + 'px' },
            },
            caret,
            h('span', { class: 'tree-icon bt-' + (def?.category ?? 'task') }, icon(def?.icon ?? 'dots', 14)),
            h('span', { class: 'bt-id', text: n.id }),
            h('span', { class: 'bt-type', text: def?.label ?? n.type }),
            brief ? h('span', { class: 'bt-brief', text: brief, title: brief }) : null,
            tags,
            status,
            mark,
        );
        row.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            this.el.focus({ preventScroll: true });
            if (e.shiftKey && this.anchor) {
                const ids = this.visibleIds();
                const a = ids.indexOf(this.anchor), b = ids.indexOf(n.id);
                if (a >= 0 && b >= 0) {
                    const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
                    if (a > b) range.reverse();
                    this.select(range.filter((id) => id !== n.id).concat(n.id));
                    return;
                }
            }
            if (e.ctrlKey || e.metaKey) {
                const i = this.selection.indexOf(n.id);
                this.select(i >= 0 ? this.selection.filter((x) => x !== n.id) : [...this.selection, n.id]);
            } else if (!this.selection.includes(n.id) || this.selection.length > 1 || this.primary !== n.id) {
                this.select([n.id]);
            }
            this.anchor = n.id;
        });
        row.addEventListener('dblclick', (e) => {
            if ((e.target as HTMLElement).closest('.bt-id')) this.startRename(n.id);
            else if (hasKids) {
                if (this.collapsed.has(n.id)) this.collapsed.delete(n.id);
                else this.collapsed.add(n.id);
                this.render(true);
            }
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.selection.includes(n.id)) this.select([n.id]);
            showMenu(this.menu(tree, n, parent), e.clientX, e.clientY);
        });
        if (parent && !this.host.locked()) this.bindDrag(row, tree, n, isCompositeDoc(n));
        return row;
    }

    private visibleIds(): string[] {
        return Array.from(this.el.querySelectorAll<HTMLElement>('.bt-row')).map((r) => r.dataset.id!);
    }

    // ------------------------------------------------------------ drag & drop

    /** Selected nodes without the ones inside another selected node, in tree order. */
    private roots(tree: BehaviorTreeDoc): string[] {
        const order: string[] = [];
        walkNodes(tree.root, (n) => order.push(n.id));
        const inside = (id: string, anc: string) => {
            const hit = findNode(tree, anc);
            let found = false;
            if (hit) walkNodes(hit.node, (n) => {
                if (n.id === id && n.id !== anc) found = true;
            });
            return found;
        };
        return order.filter((id) => this.selection.includes(id) && id !== tree.root.id && !this.selection.some((o) => o !== id && inside(id, o)));
    }

    private bindDrag(row: HTMLElement, tree: BehaviorTreeDoc, n: BtNodeDoc, composite: boolean) {
        row.addEventListener('dragstart', (e) => {
            this.dragIds = this.selection.includes(n.id) ? this.roots(tree) : [n.id];
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('text/plain', n.id);
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            this.dragIds = [];
            this.clearMarks();
        });
        row.addEventListener('dragover', (e) => {
            if (!this.dragIds.length) return;
            const zone = this.zone(e, row, composite);
            if (this.dragIds.some((id) => id === n.id || this.contains(tree, id, n.id))) return;
            e.preventDefault();
            this.clearMarks();
            row.classList.add('drop-' + zone);
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
        row.addEventListener('drop', (e) => {
            if (!this.dragIds.length) return;
            e.preventDefault();
            const zone = this.zone(e, row, composite);
            this.clearMarks();
            const ids = this.dragIds;
            this.dragIds = [];
            const parent = findNode(tree, n.id)?.parent;
            const ops: BehaviorOp[] = [];
            if (zone === 'inside') {
                this.collapsed.delete(n.id);
                for (const id of ids) ops.push({ op: 'move_node', tree: tree.id, node: id, parent: n.id });
            } else if (parent) {
                let prev: string | null = null;
                for (const id of ids) {
                    if (zone === 'before') ops.push({ op: 'move_node', tree: tree.id, node: id, parent: parent.id, before: n.id });
                    else ops.push({ op: 'move_node', tree: tree.id, node: id, parent: parent.id, after: prev ?? n.id });
                    prev = id;
                }
            }
            if (ops.length) this.host.apply(ops, ids.length > 1 ? `Move ${ids.length} Nodes` : 'Move Node');
        });
    }

    private contains(tree: BehaviorTreeDoc, ancestor: string, id: string): boolean {
        const hit = findNode(tree, ancestor);
        let found = false;
        if (hit) walkNodes(hit.node, (x) => {
            if (x.id === id) found = true;
        });
        return found;
    }

    private zone(e: DragEvent, row: HTMLElement, composite: boolean): DropZone {
        const r = row.getBoundingClientRect();
        const t = (e.clientY - r.top) / r.height;
        if (!composite) return t < 0.5 ? 'before' : 'after';
        return t < 0.28 ? 'before' : t > 0.72 ? 'after' : 'inside';
    }

    private clearMarks() {
        this.el.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    }

    // ------------------------------------------------------------------ menus

    private addNode(tree: BehaviorTreeDoc, parent: string, type: string, after?: string) {
        const created = this.host.apply([{ op: 'add_node', tree: tree.id, parent, node: { type }, ...(after ? { after } : {}) }], `Add ${nodeType(type)?.label ?? type}`);
        if (created?.length) {
            this.collapsed.delete(parent);
            this.select([created[0]]);
        }
    }

    private menu(tree: BehaviorTreeDoc, n: BtNodeDoc, parent: BtNodeDoc | null): MenuItem[] {
        const locked = () => !this.host.locked();
        const composite = isCompositeDoc(n);
        const def = nodeType(n.type);
        const typeItems = (target: string, after?: string) => NODE_TYPES.map((t) => ({ label: t.label, icon: t.icon, action: () => this.addNode(tree, target, t.type, after) }));
        const roots = this.roots(tree);
        const siblings = roots.length > 0 && roots.every((id) => findNode(tree, id)?.parent?.id === findNode(tree, roots[0])?.parent?.id);
        const items: MenuItem[] = [];
        if (composite) items.push({ label: 'Add Child', icon: 'plus', enabled: locked, submenu: typeItems(n.id) });
        if (parent) items.push({ label: 'Add After', icon: 'plus', enabled: locked, submenu: typeItems(parent.id, n.id) });
        if (parent) {
            items.push({
                label: 'Add Decorator',
                icon: 'filter',
                enabled: locked,
                submenu: DECORATOR_TYPES.map((d) => ({
                    label: d.label,
                    icon: d.icon,
                    action: () => {
                        const index = n.decorators?.length ?? 0;
                        if (this.host.apply([{ op: 'add_decorator', tree: tree.id, node: n.id, decorator: this.defaultDecorator(d.type) }], `Add ${d.label}`)) this.select([n.id], { kind: 'decorator', index });
                    },
                })),
            });
        }
        items.push({
            label: 'Add Service',
            icon: 'sparkle',
            enabled: locked,
            submenu: SERVICE_TYPES.map((s) => ({
                label: s.label,
                icon: s.icon,
                action: () => {
                    const created = this.host.apply([{ op: 'add_service', tree: tree.id, node: n.id, service: { type: s.type } }], `Add ${s.label}`);
                    if (created?.length) this.select([n.id], { kind: 'service', id: created[0] });
                },
            })),
        });
        items.push({ separator: true });
        items.push({
            label: 'Wrap In',
            icon: 'layers',
            enabled: () => locked() && (siblings || roots.length === 0),
            submenu: (['selector', 'sequence', 'parallel', 'random'] as const).map((type) => ({
                label: nodeType(type)!.label,
                icon: nodeType(type)!.icon,
                action: () => {
                    const ids = roots.length ? roots : [n.id];
                    const created = this.host.apply([{ op: 'wrap_nodes', tree: tree.id, nodes: ids, type }], `Wrap in ${nodeType(type)!.label}`);
                    if (created?.length) this.select([created[0]]);
                },
            })),
        });
        const swap = NODE_TYPES.filter((t) => t.type !== n.type && (t.category === def?.category || (composite && !(n as any).children.length)));
        if (swap.length) {
            items.push({
                label: 'Change Type',
                enabled: locked,
                submenu: swap.map((t) => ({ label: t.label, icon: t.icon, action: () => this.host.apply([{ op: 'update_node', tree: tree.id, node: n.id, set: { type: t.type } }], `Make ${t.label}`) })),
            });
        }
        items.push(
            { separator: true },
            { label: 'Rename', icon: 'dots', shortcut: 'F2', enabled: locked, action: () => this.startRename(n.id) },
            { label: 'Duplicate', icon: 'copy', shortcut: 'Mod+D', enabled: () => locked() && !!parent, action: () => this.duplicate(tree) },
            { label: 'Move Up', icon: 'arrowUp', enabled: () => locked() && !!parent && (parent as any).children[0] !== n, action: () => this.nudge(tree, n.id, -1) },
            { label: 'Move Down', icon: 'arrowDown', enabled: () => locked() && !!parent && (parent as any).children[(parent as any).children.length - 1] !== n, action: () => this.nudge(tree, n.id, 1) },
            { label: 'Delete', icon: 'trash', shortcut: 'Del', enabled: () => locked() && !!parent, action: () => this.remove(tree) },
        );
        return items;
    }

    /** A new decorator with the first fitting key picked. */
    private defaultDecorator(type: string): Record<string, unknown> {
        if (type !== 'condition') return { type };
        const key = this.host.schema()?.keys[0];
        if (!key) return { type };
        const value = key.type === 'enum' ? key.values?.[0]?.value ?? null : key.type === 'bool' ? true : key.type === 'probability' ? 0.5 : key.type === 'number' ? 0 : key.type === 'string' ? '' : null;
        const op = key.type === 'probability' || key.type === 'number' ? 'ge' : key.type === 'object' ? 'set' : 'eq';
        return { type, key: key.name, op, value };
    }

    private nudge(tree: BehaviorTreeDoc, id: string, by: number) {
        const hit = findNode(tree, id);
        if (!hit?.parent) return;
        const i = hit.parent.children.indexOf(hit.node);
        this.host.apply([{ op: 'move_node', tree: tree.id, node: id, parent: hit.parent.id, index: Math.max(0, i + by) }], by < 0 ? 'Move Node Up' : 'Move Node Down');
    }

    private duplicate(tree: BehaviorTreeDoc) {
        const roots = this.roots(tree);
        if (!roots.length) return;
        const created = this.host.apply(roots.map((id) => ({ op: 'duplicate_node', tree: tree.id, node: id })), 'Duplicate');
        if (created?.length) {
            const tops = created.filter((id) => {
                const hit = findNode(this.host.tree()!, id);
                return hit && !created.includes(hit.parent?.id ?? '');
            });
            this.select(tops);
        }
    }

    private remove(tree: BehaviorTreeDoc) {
        const roots = this.roots(tree);
        if (!roots.length) return;
        if (this.host.apply(roots.map((id) => ({ op: 'delete_node', tree: tree.id, node: id })), roots.length > 1 ? `Delete ${roots.length} Nodes` : 'Delete Node')) this.select([]);
    }

    // ----------------------------------------------------------------- rename

    startRename(id: string) {
        if (this.host.locked()) return;
        const tree = this.host.tree();
        const row = this.el.querySelector<HTMLElement>(`.bt-row[data-id="${CSS.escape(id)}"]`);
        if (!row || !tree) return;
        const label = row.querySelector('.bt-id') as HTMLElement;
        const input = h('input', { class: 'tree-rename', attrs: { type: 'text', spellcheck: 'false' } });
        input.value = id;
        this.renaming = id;
        label.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (apply: boolean) => {
            if (done) return;
            done = true;
            this.renaming = null;
            const next = input.value.trim();
            if (apply && next && next !== id) this.host.apply([{ op: 'update_node', tree: tree.id, node: id, set: { id: next } }], 'Rename Node');
            this.host.selected(this.selection, null);
            this.render(true);
            this.el.focus({ preventScroll: true });
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    // --------------------------------------------------------------- keyboard

    private onKey(e: KeyboardEvent) {
        const tree = this.host.tree();
        if (!tree || this.renaming) return;
        const ids = this.visibleIds();
        const cur = this.primary;
        const i = cur ? ids.indexOf(cur) : -1;
        const mod = e.ctrlKey || e.metaKey;
        let handled = true;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) {
                this.anchor = next;
                this.select([next]);
                this.el.querySelector(`.bt-row[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
            }
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur) {
            const hit = findNode(tree, cur);
            if (e.key === 'ArrowLeft') {
                if (hit && isCompositeDoc(hit.node) && hit.node.children.length && !this.collapsed.has(cur)) this.collapsed.add(cur);
                else if (hit?.parent) this.select([hit.parent.id]);
            } else this.collapsed.delete(cur);
            this.render(true);
        } else if (e.key === 'F2' && cur) this.startRename(cur);
        else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.host.locked()) this.remove(tree);
        else if (mod && e.key.toLowerCase() === 'd' && !this.host.locked()) this.duplicate(tree);
        else handled = false;
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    }
}
