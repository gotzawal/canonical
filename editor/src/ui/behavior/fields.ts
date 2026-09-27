// Inputs for behavior tree items, generated from the node type definitions
// (core/behavior/nodeTypes.ts). Key pickers only offer keys of the tree's
// schema that fit the field (type and owner); a value takes the type of the
// key its field names (an enum value is picked from the list).

import { allModels, DEFAULT_DECIDE_MODEL, modelTask } from '../../core/behavior/models';
import { COMPARE_OPS, keyTypeInfo, type FieldDef } from '../../core/behavior/nodeTypes';
import type { AiModelDoc, BlackboardKeyDoc, BlackboardSchemaDoc, BlackboardValue } from '../../core/types';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { pretty } from '../paramFields';
import { CheckboxField, NumberField, SelectField, SliderField, TextField, row, type EditHooks } from '../widgets';

export interface FieldContext {
    schema: BlackboardSchemaDoc | undefined;
    /** Scene objects, for object values. */
    objects: () => { id: string; name: string }[];
    /** The scene's models, for model fields (the built-in ones are always offered). */
    models?: () => readonly AiModelDoc[];
}

/** How a field writes: one-shot changes, or a begin / input / end bracket (scrubbing a number). */
export type FieldEdit = Required<EditHooks<unknown>>;

export interface FieldRow {
    el: HTMLElement;
    /** Shows the current value again (after undo or an edit elsewhere). */
    sync(): void;
}

/** Keys of the schema a key field may pick. */
export function keysFor(f: FieldDef, schema: BlackboardSchemaDoc | undefined): BlackboardKeyDoc[] {
    return (schema?.keys ?? []).filter((k) => (!f.keyTypes || f.keyTypes.includes(k.type)) && (!f.keyOwners || f.keyOwners.includes(k.owner)));
}

function keyLabel(k: BlackboardKeyDoc): string {
    return `${k.name} (${k.owner} ${k.type})`;
}

/** An input for a value of a key's type. */
export function valueControl(key: BlackboardKeyDoc | undefined, value: BlackboardValue, ctx: FieldContext, edit: FieldEdit): { el: HTMLElement; set(v: BlackboardValue): void } {
    if (!key) {
        const el = h('div', { class: 'readonly muted', text: 'Pick a key first' });
        return { el, set: () => {} };
    }
    switch (key.type) {
        case 'bool': {
            const f = new SelectField<'true' | 'false'>([{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }], value === true ? 'true' : 'false', (v) => edit.commit(v === 'true'));
            return { el: f.el, set: (v) => f.set(v === true ? 'true' : 'false') };
        }
        case 'number': {
            const f = new NumberField({ value: typeof value === 'number' ? value : 0, step: 0.05, precision: 3, begin: edit.begin, input: edit.input, end: edit.end, commit: edit.commit });
            return { el: f.el, set: (v) => f.set(typeof v === 'number' ? v : 0) };
        }
        case 'probability': {
            const f = new SliderField({ value: typeof value === 'number' ? value : 0, min: 0, max: 1, step: 0.01, precision: 2, begin: edit.begin, input: edit.input, end: edit.end, commit: edit.commit });
            return { el: f.el, set: (v) => f.set(typeof v === 'number' ? v : 0) };
        }
        case 'enum': {
            const values = key.values ?? [];
            const opts = values.map((v) => ({ value: v.value, label: v.description ? `${v.value} - ${v.description}` : v.value }));
            const known = values.some((v) => v.value === value);
            if (!known) opts.unshift({ value: String(value ?? ''), label: `${value === null ? '(none)' : String(value)} (not a value)` });
            const f = new SelectField<string>(opts, String(value ?? ''), (v) => edit.commit(v));
            return { el: f.el, set: (v) => f.set(String(v ?? '')) };
        }
        case 'string': {
            const f = new TextField(String(value ?? ''), (v) => edit.commit(v));
            return { el: f.el, set: (v) => f.set(String(v ?? '')) };
        }
        case 'object': {
            const opts = [{ value: '', label: '(none)' }, ...ctx.objects().map((o) => ({ value: o.id, label: o.name }))];
            if (typeof value === 'string' && value && !opts.some((o) => o.value === value)) opts.push({ value, label: `${value} (missing)` });
            const f = new SelectField<string>(opts, typeof value === 'string' ? value : '', (v) => edit.commit(v || null));
            return { el: f.el, set: (v) => f.set(typeof v === 'string' ? v : '') };
        }
    }
}

/** A row for one field of an item; `get` reads the item as it is now. */
export function fieldRow(f: FieldDef, get: () => any, ctx: FieldContext, edit: FieldEdit): FieldRow {
    const item = get();
    const v = item?.[f.name];
    const label = f.label || pretty(f.name);
    const wrap = (control: HTMLElement, sync: () => void): FieldRow => {
        const el = row(label, control, f.description);
        const show = () => {
            el.hidden = !!f.when && !f.when(get());
        };
        show();
        return {
            el,
            sync: () => {
                show();
                sync();
            },
        };
    };
    switch (f.kind) {
        case 'number':
        case 'integer':
        case 'seconds': {
            const w = new NumberField({
                value: typeof v === 'number' ? v : 0,
                step: f.kind === 'integer' ? 0.25 : 0.05,
                min: f.min,
                max: f.max,
                precision: f.kind === 'integer' ? 0 : 3,
                suffix: f.kind === 'seconds' ? ' s' : '',
                begin: edit.begin,
                input: (x) => edit.input(f.kind === 'integer' ? Math.round(x) : x),
                end: edit.end,
                commit: (x) => edit.commit(f.kind === 'integer' ? Math.round(x) : x),
            });
            return wrap(w.el, () => w.set(Number(get()?.[f.name]) || 0));
        }
        case 'unit': {
            const w = new SliderField({ value: typeof v === 'number' ? v : 0, min: 0, max: 1, step: 0.01, precision: 2, begin: edit.begin, input: edit.input, end: edit.end, commit: edit.commit });
            return wrap(w.el, () => w.set(Number(get()?.[f.name]) || 0));
        }
        case 'text':
        case 'method':
        case 'template': {
            const hint = f.kind === 'template' ? `e.g. rumors about {${ctx.schema?.keys[0]?.name ?? 'key'}}` : f.kind === 'method' ? 'methodName' : '';
            const w = new TextField(String(v ?? ''), (x) => edit.commit(f.kind === 'method' ? x.trim() : x), hint);
            if (f.kind === 'template') w.el.title = `Keys: ${(ctx.schema?.keys ?? []).map((k) => `{${k.name}}`).join(' ')}\nContext pool: {context}, or one slot: {context:slot}`;
            return wrap(w.el, () => w.set(String(get()?.[f.name] ?? '')));
        }
        case 'bool': {
            const w = new CheckboxField(!!v, (x) => edit.commit(x));
            return wrap(w.el, () => w.set(!!get()?.[f.name]));
        }
        case 'choice': {
            const w = new SelectField<string>((f.choices ?? []).map((c) => ({ value: c.value, label: c.label })), String(v ?? f.default), (x) => edit.commit(x));
            if (f.name === 'op') w.el.title = COMPARE_OPS.map((o) => `${o.symbol}: ${o.description}`).join('\n');
            return wrap(w.el, () => w.set(String(get()?.[f.name] ?? f.default)));
        }
        case 'flags': {
            const box = h('div', { class: 'bt-flags' });
            const checks = (f.choices ?? []).map((c) => {
                const w = new CheckboxField(Array.isArray(v) && v.includes(c.value), (on) => {
                    const cur: string[] = Array.isArray(get()?.[f.name]) ? get()[f.name] : [];
                    const next = (f.choices ?? []).map((x) => x.value).filter((x) => (x === c.value ? on : cur.includes(x)));
                    edit.commit(next);
                }, c.label);
                w.el.title = c.description ?? '';
                box.appendChild(w.el);
                return { c, w };
            });
            return wrap(box, () => {
                const cur: string[] = Array.isArray(get()?.[f.name]) ? get()[f.name] : [];
                for (const { c, w } of checks) w.set(cur.includes(c.value));
            });
        }
        case 'key': {
            const list = () => keysFor(f, ctx.schema);
            const options = () => {
                const cur = String(get()?.[f.name] ?? '');
                const opts = [{ value: '', label: '(pick a key)' }, ...list().map((k) => ({ value: k.name, label: keyLabel(k) }))];
                if (cur && !opts.some((o) => o.value === cur)) opts.push({ value: cur, label: `${cur} (not usable here)` });
                return opts;
            };
            const w = new SelectField<string>(options(), String(v ?? ''), (x) => edit.commit(x));
            return wrap(w.el, () => w.set(String(get()?.[f.name] ?? '')));
        }
        case 'keys': {
            const box = h('div', { class: 'bt-chips' });
            const render = () => {
                clear(box);
                const cur: string[] = Array.isArray(get()?.[f.name]) ? get()[f.name] : [];
                const keys = keysFor(f, ctx.schema);
                for (const k of keys) {
                    const on = cur.includes(k.name);
                    const chip = h('button', { class: 'chip' + (on ? ' active' : ''), text: k.name, title: `${k.type}${k.description ? `: ${k.description}` : ''}`, attrs: { type: 'button' } });
                    chip.addEventListener('click', () => {
                        const now: string[] = Array.isArray(get()?.[f.name]) ? get()[f.name] : [];
                        edit.commit(now.includes(k.name) ? now.filter((x) => x !== k.name) : keys.map((x) => x.name).filter((x) => x === k.name || now.includes(x)));
                    });
                    box.appendChild(chip);
                }
                for (const name of cur.filter((n) => !keys.some((k) => k.name === n))) box.appendChild(h('span', { class: 'chip error', text: `${name}?`, title: 'Not a usable key' }));
                if (!keys.length) box.appendChild(h('span', { class: 'muted small', text: f.keyOwners?.includes('fact') ? 'The schema has no fact keys.' : 'No keys to pick.' }));
            };
            render();
            return wrap(box, render);
        }
        case 'value': {
            const holder = h('div', { class: 'bt-value' });
            let keyName = '';
            let control: { el: HTMLElement; set(v: BlackboardValue): void } | null = null;
            const render = () => {
                const it = get();
                const name = String(it?.[f.keyField ?? 'key'] ?? '');
                const key = ctx.schema?.keys.find((k) => k.name === name);
                const sig = key ? `${key.name}|${key.type}|${(key.values ?? []).map((x) => x.value).join(',')}` : '';
                if (!control || sig !== keyName) {
                    keyName = sig;
                    control = valueControl(key, it?.[f.name] ?? null, ctx, edit);
                    holder.replaceChildren(control.el);
                } else control.set(it?.[f.name] ?? null);
            };
            render();
            return wrap(holder, render);
        }
        case 'tags': {
            const w = new TextField(Array.isArray(v) ? v.join(', ') : '', (x) => edit.commit(x.split(',').map((t) => t.trim()).filter(Boolean)), 'tag, tag');
            return wrap(w.el, () => w.set(Array.isArray(get()?.[f.name]) ? get()[f.name].join(', ') : ''));
        }
        case 'questions':
            return questionsRow(f, get, ctx, edit);
        case 'model': {
            // Models that do what the field needs; an empty value is the default one (Ask) or none.
            const cur = String(v ?? '');
            const fits = allModels(ctx.models?.() ?? []).filter((m) => !f.modelTasks || f.modelTasks.includes(modelTask(m)!));
            const none = f.required ? '(pick a model)' : f.modelTasks?.includes('decide') ? `Default (${DEFAULT_DECIDE_MODEL})` : '(none)';
            const opts = [{ value: '', label: none }, ...fits.map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }))];
            if (cur && !opts.some((o) => o.value === cur)) opts.push({ value: cur, label: `${cur} (not usable here)` });
            const w = new SelectField<string>(opts, cur, (x) => edit.commit(x));
            return wrap(w.el, () => w.set(String(get()?.[f.name] ?? '')));
        }
    }
}

/** Target key and question per row. */
function questionsRow(f: FieldDef, get: () => any, ctx: FieldContext, edit: FieldEdit): FieldRow {
    const list = h('div', { class: 'bt-questions' });
    const current = (): { key: string; text: string }[] => (Array.isArray(get()?.questions) ? get().questions.map((q: any) => ({ key: q.key, text: q.text })) : []);
    const aiKeys = () => (ctx.schema?.keys ?? []).filter((k) => k.owner === 'ai');
    const render = () => {
        clear(list);
        const qs = current();
        qs.forEach((q, i) => {
            const opts = [{ value: '', label: '(key)' }, ...aiKeys().map((k) => ({ value: k.name, label: `${k.name} (${k.type === 'probability' ? 'Noul' : k.type === 'enum' ? 'Choice' : k.type})` }))];
            if (q.key && !opts.some((o) => o.value === q.key)) opts.push({ value: q.key, label: `${q.key} (not an AI key)` });
            const key = new SelectField<string>(opts, q.key, (v) => {
                const next = current();
                next[i].key = v;
                edit.commit(next);
            });
            const text = new TextField(q.text, (v) => {
                const next = current();
                next[i].text = v;
                edit.commit(next);
            }, 'The question, e.g. "Is the player a threat?"');
            const remove = h('button', { class: 'icon-btn', title: 'Remove question', attrs: { type: 'button', 'aria-label': 'Remove question' } }, icon('close', 13));
            remove.addEventListener('click', () => edit.commit(current().filter((_, j) => j !== i)));
            list.appendChild(h('div', { class: 'bt-question' }, h('div', { class: 'bt-question-head' }, key.el, remove), text.el));
        });
        const add = h('button', { class: 'btn small subtle', attrs: { type: 'button' } }, icon('plus', 13), h('span', { text: 'Question' }));
        add.addEventListener('click', () => {
            const used = new Set(current().map((q) => q.key));
            const k = aiKeys().find((x) => !used.has(x.name));
            edit.commit([...current(), { key: k?.name ?? '', text: '' }]);
        });
        list.appendChild(add);
        if (!aiKeys().length) list.appendChild(h('div', { class: 'muted small', text: 'Add an AI key to the blackboard schema (owner ai) to ask about it.' }));
    };
    render();
    const el = h('div', { class: 'bt-questions-row' }, h('div', { class: 'row-label wide', text: f.label, title: f.description }), list);
    return { el, sync: render };
}

/** Short text of a key's type, for badges. */
export function keyTypeText(k: BlackboardKeyDoc): string {
    return k.type === 'enum' ? `enum (${(k.values ?? []).length})` : keyTypeInfo(k.type).label.toLowerCase();
}
