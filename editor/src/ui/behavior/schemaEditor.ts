// The blackboard schema editor: the keys of a schema (name, type, owner,
// default, description, enum values). A new name is written into every tree
// and object that uses the key; a key in use cannot be deleted (the message
// lists its users). All through edit operations.

import { KEY_OWNERS, KEY_TYPES, formatValue } from '../../core/behavior/nodeTypes';
import type { BehaviorOp } from '../../core/behavior/ops';
import type { Issue } from '../../core/behavior/validate';
import type { BlackboardKeyDoc, BlackboardSchemaDoc, EnumValueDoc } from '../../core/types';
import type { Editor } from '../../editor';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { FieldSteps, SelectField, TextField, TextAreaField, button, iconButton, row } from '../widgets';
import { keyTypeText, valueControl } from './fields';

export interface SchemaHost {
    editor: Editor;
    schema(): BlackboardSchemaDoc | undefined;
    issues(): Issue[];
    locked(): boolean;
    apply(ops: BehaviorOp[], label: string): boolean;
}

export class SchemaEditor {
    readonly el: HTMLElement;
    private list: HTMLElement;
    private detail: HTMLElement;
    private selected: string | null = null;
    private key = '';
    private steps: FieldSteps;

    constructor(private host: SchemaHost) {
        this.steps = new FieldSteps(host.editor.store);
        this.list = h('div', { class: 'bt-keys' });
        this.detail = h('div', { class: 'bt-props' });
        this.el = h('div', { class: 'bt-split' }, h('div', { class: 'bt-split-main' }, this.list), h('div', { class: 'bt-split-side' }, this.detail));
    }

    render(force = false) {
        const s = this.host.schema();
        const key = JSON.stringify([s, this.selected, this.host.issues().map((i) => i.message), this.host.locked()]);
        if (!force && key === this.key) return;
        if (!force && this.el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName !== 'BUTTON') {
            // Typing in a field: keep it; the list still follows.
            this.renderList();
            return;
        }
        this.key = key;
        this.renderList();
        this.renderDetail();
    }

    private renderList() {
        const s = this.host.schema();
        clear(this.list);
        if (!s) {
            this.list.appendChild(h('div', { class: 'empty-hint', text: 'This tree has no blackboard schema. Pick one above or create one.' }));
            return;
        }
        const locked = this.host.locked();
        const issues = this.host.issues();
        this.list.appendChild(
            h(
                'div',
                { class: 'bt-keys-head' },
                h('span', { class: 'muted small', text: `${s.keys.length} key${s.keys.length === 1 ? '' : 's'} in ${s.name}` }),
                h('div', { class: 'spacer' }),
                locked ? null : button('Key', () => this.addKey(s), 'small', 'plus'),
            ),
        );
        for (const k of s.keys) {
            const mine = issues.filter((i) => i.node === k.name);
            const r = h(
                'div',
                { class: 'bt-key-row' + (this.selected === k.name ? ' selected' : '') + (mine.some((i) => i.severity === 'error') ? ' has-error' : mine.length ? ' has-warning' : '') },
                h('span', { class: 'bt-owner ' + k.owner, text: k.owner }),
                h('span', { class: 'bt-key-name', text: k.name }),
                h('span', { class: 'bt-key-type', text: keyTypeText(k) }),
                h('span', { class: 'bt-key-default', text: `= ${formatValue(k.default)}` }),
                h('span', { class: 'bt-key-desc muted', text: k.description }),
                mine.length ? h('span', { class: 'bt-mark ' + (mine.some((i) => i.severity === 'error') ? 'error' : 'warning'), title: mine.map((i) => i.message).join('\n') }, icon('alert', 12)) : null,
            );
            r.addEventListener('click', () => {
                this.selected = k.name;
                this.render(true);
            });
            this.list.appendChild(r);
        }
        if (!s.keys.length) this.list.appendChild(h('div', { class: 'empty-hint', text: 'No keys yet. Facts are written by scripts, AI keys by one Ask, tree keys by Set Key and script tasks.' }));
    }

    private addKey(s: BlackboardSchemaDoc) {
        let i = s.keys.length + 1;
        while (s.keys.some((k) => k.name === `key_${i}`)) i++;
        const name = `key_${i}`;
        if (this.host.apply([{ op: 'add_key', schema: s.id, key: { name, type: 'enum', owner: 'fact', values: [{ value: 'none', description: '' }] } }], 'Add Key')) {
            this.selected = name;
            this.render(true);
        }
    }

    private renderDetail() {
        this.steps.close();
        clear(this.detail);
        const s = this.host.schema();
        const k = s?.keys.find((x) => x.name === this.selected);
        if (!s || !k) {
            this.detail.appendChild(h('div', { class: 'empty-hint', text: s ? 'Select a key to edit it.' : '' }));
            return;
        }
        const locked = this.host.locked();
        const body = h('div', { class: 'bt-props-body' });
        if (locked) body.setAttribute('inert', '');
        const set = (patch: Record<string, unknown>, label: string) => {
            if (this.host.apply([{ op: 'update_key', schema: s.id, key: k.name, set: patch }], label) && typeof patch.name === 'string') this.selected = patch.name;
            this.render(true);
        };
        const name = new TextField(k.name, (v) => v.trim() && v.trim() !== k.name && set({ name: v.trim() }, 'Rename Key'));
        name.el.classList.add('name-input');
        const type = new SelectField(KEY_TYPES.map((t) => ({ value: t.type, label: t.label })), k.type, (v) => set({ type: v, ...(v === 'enum' && !k.values?.length ? { values: [{ value: 'none', description: '' }] } : {}) }, 'Key Type'));
        type.el.title = KEY_TYPES.map((t) => `${t.label}: ${t.description}`).join('\n');
        const owner = new SelectField(KEY_OWNERS.map((o) => ({ value: o.owner, label: o.label })), k.owner, (v) => set({ owner: v }, 'Key Owner'));
        owner.el.title = KEY_OWNERS.find((o) => o.owner === k.owner)?.description ?? '';
        const def = valueControl(
            k,
            k.default,
            { schema: s, objects: () => this.host.editor.store.doc.nodes.map((n) => ({ id: n.id, name: n.name })) },
            this.steps.hooks('Behavior: Key Default', (v) => this.host.apply([{ op: 'update_key', schema: s.id, key: k.name, set: { default: v } }], 'Key Default'), () => this.render(true)),
        );
        const desc = new TextAreaField(k.description, (v) => set({ description: v }, 'Key Description'), 'What the key means', 2);
        const remove = button('Delete Key', () => {
            if (this.host.apply([{ op: 'delete_key', schema: s.id, key: k.name }], 'Delete Key')) this.selected = null;
            this.render(true);
        }, 'small danger subtle', 'trash');
        const move = (by: number) => {
            const i = s.keys.indexOf(k);
            this.host.apply([{ op: 'move_key', schema: s.id, key: k.name, index: Math.max(0, i + by) }], 'Move Key');
            this.render(true);
        };
        body.append(
            h('div', { class: 'inspector-title' }, h('span', { class: 'tree-icon' }, icon('key', 17)), name.el),
            row('Type', type.el),
            row('Owner', owner.el, KEY_OWNERS.find((o) => o.owner === k.owner)?.description),
            h('div', { class: 'muted small pad', text: KEY_OWNERS.find((o) => o.owner === k.owner)?.description ?? '' }),
            row('Default', def.el),
            row('Description', desc.el),
        );
        if (k.type === 'enum') body.append(this.valuesEditor(s, k));
        const mine = this.host.issues().filter((i) => i.node === k.name);
        if (mine.length) body.append(h('div', { class: 'bt-issues' }, mine.map((i) => h('div', { class: 'bt-issue ' + i.severity }, icon(i.severity === 'error' ? 'alert' : 'info', 12), h('span', { text: i.message })))));
        body.append(h('div', { class: 'inline wrap bt-key-actions' }, iconButton('arrowUp', 'Move up', () => move(-1)), iconButton('arrowDown', 'Move down', () => move(1)), h('div', { class: 'spacer' }), remove));
        this.detail.appendChild(body);
    }

    /** Enum values with their descriptions (the option texts of Choice questions). */
    private valuesEditor(s: BlackboardSchemaDoc, k: BlackboardKeyDoc): HTMLElement {
        const values = (): EnumValueDoc[] => (k.values ?? []).map((v) => ({ ...v }));
        const write = (next: EnumValueDoc[], label: string) => {
            this.host.apply([{ op: 'update_key', schema: s.id, key: k.name, set: { values: next } }], label);
            this.render(true);
        };
        const rows = values().map((v, i) => {
            const value = new TextField(v.value, (x) => {
                const next = values();
                next[i].value = x.trim();
                write(next, 'Enum Value');
            }, 'value');
            const desc = new TextField(v.description, (x) => {
                const next = values();
                next[i].description = x;
                write(next, 'Enum Description');
            }, k.owner === 'ai' ? 'What the model sees as the option' : 'description');
            const remove = iconButton('close', 'Remove value', () => write(values().filter((_, j) => j !== i), 'Remove Enum Value'));
            return h('div', { class: 'bt-enum-row' }, value.el, desc.el, remove);
        });
        const add = button('Value', () => {
            const cur = values();
            let n = cur.length + 1;
            while (cur.some((v) => v.value === `value_${n}`)) n++;
            write([...cur, { value: `value_${n}`, description: '' }], 'Add Enum Value');
        }, 'small subtle', 'plus');
        return h(
            'div',
            { class: 'bt-enum' },
            h('div', { class: 'bt-group-title' }, h('span', { text: 'Values' }), h('span', { class: 'muted small', text: k.owner === 'ai' ? 'descriptions are the Choice options' : 'in order' })),
            rows,
            add,
        );
    }
}
