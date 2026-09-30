// Properties of the selected behavior tree node: its fields, decorators and
// services, with inputs generated from the node type definitions. Every
// change is an edit operation (one undo step; a number dragged is one step
// too).

import { decoratorType, DECORATOR_TYPES, keyTypeInfo, nodeType, serviceType, SERVICE_TYPES, typeDefault, valueFits, type FieldDef, type ItemTypeDef } from '../../core/behavior/nodeTypes';
import type { BehaviorOp } from '../../core/behavior/ops';
import type { Issue } from '../../core/behavior/validate';
import type { BehaviorTreeDoc, BlackboardSchemaDoc, BtDecoratorDoc, BtNodeDoc, BtServiceDoc } from '../../core/types';
import type { Editor } from '../../editor';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { FieldSteps, TextField, button, iconButton, row } from '../widgets';
import { fieldRow, type FieldContext, type FieldEdit } from './fields';
import type { FocusPart } from './outliner';

export interface PropertiesHost {
    editor: Editor;
    tree(): BehaviorTreeDoc | undefined;
    schema(): BlackboardSchemaDoc | undefined;
    node(): BtNodeDoc | undefined;
    part(): FocusPart;
    issues(): Issue[];
    locked(): boolean;
    apply(ops: BehaviorOp[], label: string): string[] | null;
    focusPart(part: FocusPart): void;
}

export class PropertiesPanel {
    readonly el: HTMLElement;
    private syncs: (() => void)[] = [];
    private shape = '';
    private steps: FieldSteps;

    constructor(private host: PropertiesHost) {
        this.el = h('div', { class: 'bt-props' });
        this.steps = new FieldSteps(host.editor.store);
    }

    private shapeKey(): string {
        const n = this.host.node();
        const t = this.host.tree();
        const s = this.host.schema();
        if (!n || !t) return 'none';
        return JSON.stringify([
            t.id,
            n.id,
            n.type,
            (n.decorators ?? []).map((d) => d.type),
            (n.services ?? []).map((x) => x.id + x.type + ((x as any).questions?.length ?? 0)),
            (n as any).questions?.length ?? 0,
            s?.id,
            s?.keys.map((k) => k.name + k.type + k.owner + (k.values ?? []).map((v) => v.value + v.description).join()),
            this.host.issues().filter((i) => i.node === n.id || n.services?.some((x) => x.id === i.node)).map((i) => i.message),
            this.host.locked(),
            this.host.part(),
        ]);
    }

    /** Called after any change: rebuilds when the shape changed, otherwise updates the values. */
    refresh() {
        if (this.steps.active) return;
        if (this.shapeKey() !== this.shape) this.render();
        else for (const s of this.syncs) s();
    }

    render() {
        this.steps.close();
        this.shape = this.shapeKey();
        this.syncs = [];
        const scroll = this.el.scrollTop;
        clear(this.el);
        const tree = this.host.tree();
        const node = this.host.node();
        if (!tree || !node) {
            this.el.appendChild(h('div', { class: 'empty-hint', text: tree ? 'Select a node to edit it. Right-click a node to add children, decorators and services.' : '' }));
            return;
        }
        const def = nodeType(node.type);
        const locked = this.host.locked();
        const body = h('div', { class: 'bt-props-body' + (locked ? ' locked' : '') });
        if (locked) body.setAttribute('inert', '');
        if (locked) this.el.append(h('div', { class: 'bt-banner' }, icon('lock', 13), h('span', { text: 'Playing: the tree is shown as it runs. Stop to edit it.' })));
        this.el.append(body);
        body.append(this.header(tree, node, def));
        const mine = this.host.issues().filter((i) => i.node === node.id);
        if (mine.length) body.append(this.issueList(mine));
        if (def) for (const f of def.fields) body.append(this.field(f, () => this.host.node(), (set, label) => this.edit({ op: 'update_node', tree: tree.id, node: node.id, set }, label), def));
        body.append(this.decorators(tree, node));
        body.append(this.services(tree, node));
        this.el.scrollTop = scroll;
        const part = this.host.part();
        if (part) requestAnimationFrame(() => this.el.querySelector('.bt-part.focused')?.scrollIntoView({ block: 'nearest' }));
    }

    // ------------------------------------------------------------ editing

    /** A one-shot edit, or part of a continuous one (inside begin / end). */
    private edit(op: BehaviorOp, label: string) {
        this.host.apply([op], label);
    }

    private editHooks(send: (value: unknown) => void, label: string): FieldEdit {
        return this.steps.hooks(`Behavior: ${label}`, send, { after: () => this.refresh() });
    }

    private context(): FieldContext {
        return {
            schema: this.host.schema(),
            objects: () => this.host.editor.store.doc.nodes.filter((n) => !n.prefabChild).map((n) => ({ id: n.id, name: n.name })),
            models: () => this.host.editor.store.doc.aiModels,
        };
    }

    /** A field row that writes `{ [field]: value }` (with fixes for the fields that depend on a key). */
    private field(f: FieldDef, get: () => any, write: (set: Record<string, unknown>, label: string) => void, def: ItemTypeDef): HTMLElement {
        const label = `${def.label} ${f.label}`;
        const hooks = this.editHooks((value) => write(this.withDependents(get(), f, value), label), label);
        const r = fieldRow(f, get, this.context(), hooks);
        this.syncs.push(() => {
            if (get()) r.sync();
        });
        return r.el;
    }

    /** Changing a key also fixes the comparison and value so they fit the new key. */
    private withDependents(item: any, f: FieldDef, value: unknown): Record<string, unknown> {
        const set: Record<string, unknown> = { [f.name]: value };
        if (f.kind !== 'key' || !item) return set;
        const key = this.host.schema()?.keys.find((k) => k.name === value);
        if (!key) return set;
        if ('op' in item && !keyTypeInfo(key.type).ops.includes(item.op)) set.op = key.type === 'object' ? 'set' : 'eq';
        if ('value' in item && !valueFits(key, item.value)) set.value = key.type === 'probability' ? 0.5 : typeDefault(key.type, key.values);
        return set;
    }

    // ------------------------------------------------------------- parts

    private header(tree: BehaviorTreeDoc, node: BtNodeDoc, def: ItemTypeDef | undefined): HTMLElement {
        const id = new TextField(node.id, (v) => {
            const next = v.trim();
            if (!next || next === node.id) return;
            if (!this.host.apply([{ op: 'update_node', tree: tree.id, node: node.id, set: { id: next } }], 'Rename Node')) id.set(node.id);
        });
        id.el.classList.add('name-input');
        const note = new TextField(node.note ?? '', (v) => this.host.apply([{ op: 'update_node', tree: tree.id, node: node.id, set: { note: v } }], 'Node Note'), 'Note');
        this.syncs.push(() => {
            const n = this.host.node();
            if (!n) return;
            id.set(n.id);
            note.set(n.note ?? '');
        });
        return h(
            'div',
            { class: 'bt-props-head' },
            h('div', { class: 'inspector-title' }, h('span', { class: 'tree-icon bt-' + (def?.category ?? 'task') }, icon(def?.icon ?? 'dots', 17)), id.el, h('span', { class: 'bt-type', text: def?.label ?? node.type })),
            def ? h('div', { class: 'muted small bt-summary', text: def.summary }) : null,
            row('Note', note.el),
        );
    }

    private issueList(list: Issue[]): HTMLElement {
        return h(
            'div',
            { class: 'bt-issues' },
            list.map((i) => h('div', { class: 'bt-issue ' + i.severity }, icon(i.severity === 'error' ? 'alert' : 'info', 12), h('span', { text: `${i.field ? i.field + ': ' : ''}${i.message}` }))),
        );
    }

    private partBox(title: Element[], body: HTMLElement[], focused: boolean, onRemove: () => void, onFocus: () => void): HTMLElement {
        const remove = iconButton('trash', 'Remove', (e) => {
            e.stopPropagation();
            onRemove();
        });
        const head = h('div', { class: 'bt-part-head' }, ...title, h('div', { class: 'spacer' }), remove);
        head.addEventListener('click', onFocus);
        return h('div', { class: 'bt-part' + (focused ? ' focused' : '') }, head, h('div', { class: 'bt-part-body' }, body));
    }

    private decorators(tree: BehaviorTreeDoc, node: BtNodeDoc): HTMLElement {
        const isRoot = tree.root.id === node.id;
        const part = this.host.part();
        const list = (node.decorators ?? []).map((d: BtDecoratorDoc, i) => {
            const def = decoratorType(d.type)!;
            const get = () => this.host.node()?.decorators?.[i];
            const keys = (name: string) => this.host.schema()?.keys.find((k) => k.name === name);
            const brief = h('span', { class: 'muted', text: def.brief(d, keys) });
            this.syncs.push(() => {
                const cur = get();
                if (cur) brief.textContent = def.brief(cur, keys);
            });
            const fields = def.fields.map((f) => this.field(f, get, (set, label) => this.edit({ op: 'update_decorator', tree: tree.id, node: node.id, index: i, set }, label), def));
            return this.partBox(
                [icon(def.icon, 13), h('span', { class: 'bt-part-title', text: def.label }), brief],
                fields,
                part?.kind === 'decorator' && part.index === i,
                () => this.host.apply([{ op: 'remove_decorator', tree: tree.id, node: node.id, index: i }], `Remove ${def.label}`),
                () => this.host.focusPart({ kind: 'decorator', index: i }),
            );
        });
        const add = h(
            'div',
            { class: 'inline wrap' },
            DECORATOR_TYPES.map((d) =>
                button(d.label, () => {
                    const index = node.decorators?.length ?? 0;
                    if (this.host.apply([{ op: 'add_decorator', tree: tree.id, node: node.id, decorator: this.newDecorator(d.type) }], `Add ${d.label}`)) this.host.focusPart({ kind: 'decorator', index });
                }, 'small subtle', 'plus'),
            ),
        );
        return h(
            'section',
            { class: 'bt-group' },
            h('div', { class: 'bt-group-title' }, h('span', { text: 'Decorators' }), h('span', { class: 'muted small', text: isRoot ? 'not on the root' : 'conditions, cooldowns, results and repeats' })),
            list,
            isRoot ? null : add,
        );
    }

    private newDecorator(type: string): Record<string, unknown> {
        if (type !== 'condition') return { type };
        const key = this.host.schema()?.keys.find((k) => k.owner === 'ai') ?? this.host.schema()?.keys[0];
        if (!key) return { type };
        const op = key.type === 'probability' || key.type === 'number' ? 'ge' : key.type === 'object' ? 'set' : 'eq';
        const value = key.type === 'probability' ? 0.5 : key.type === 'bool' ? true : typeDefault(key.type, key.values);
        return { type, key: key.name, op, value };
    }

    private services(tree: BehaviorTreeDoc, node: BtNodeDoc): HTMLElement {
        const part = this.host.part();
        const list = (node.services ?? []).map((s: BtServiceDoc) => {
            const def = serviceType(s.type)!;
            const sid = s.id;
            const get = () => this.host.node()?.services?.find((x) => x.id === sid);
            const id = new TextField(s.id, (v) => {
                const next = v.trim();
                if (!next || next === sid) return;
                if (this.host.apply([{ op: 'update_service', tree: tree.id, service: sid, set: { id: next } }], 'Rename Service')) this.host.focusPart({ kind: 'service', id: next });
                else id.set(sid);
            });
            id.el.classList.add('bt-part-id');
            const issues = this.host.issues().filter((i) => i.node === sid);
            const fields = def.fields.map((f) => this.field(f, get, (set, label) => this.edit({ op: 'update_service', tree: tree.id, service: sid, set }, label), def));
            return this.partBox(
                [icon(def.icon, 13), id.el, h('span', { class: 'muted', text: def.label })],
                [...(issues.length ? [this.issueList(issues)] : []), ...fields],
                part?.kind === 'service' && part.id === sid,
                () => this.host.apply([{ op: 'remove_service', tree: tree.id, service: sid }], `Remove ${def.label}`),
                () => this.host.focusPart({ kind: 'service', id: sid }),
            );
        });
        const add = h(
            'div',
            { class: 'inline wrap' },
            SERVICE_TYPES.map((s) =>
                button(s.label, () => {
                    const created = this.host.apply([{ op: 'add_service', tree: tree.id, node: node.id, service: { type: s.type } }], `Add ${s.label}`);
                    if (created?.length) this.host.focusPart({ kind: 'service', id: created[0] });
                }, 'small subtle', 'plus'),
            ),
        );
        return h(
            'section',
            { class: 'bt-group' },
            h('div', { class: 'bt-group-title' }, h('span', { text: 'Services' }), h('span', { class: 'muted small', text: 'run while this node is active' })),
            list,
            add,
        );
    }
}
