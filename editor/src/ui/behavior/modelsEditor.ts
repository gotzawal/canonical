// The Models view of the Behavior tab: the models the scene's agents can
// use. Laya and multilingual-e5 are built in; the scene adds its own: any
// small ONNX model of a known kind (core/behavior/models.ts), by the URL of
// its folder. Their files download once into this browser and run in the
// inference worker. Ask nodes pick decide models, Model tasks classify and
// generate models, the memory an embed model.

import { formatBytes } from '../../core/assets';
import { allModels, BUILTIN_MODELS, DEFAULT_DECIDE_MODEL, MODEL_KINDS, MODEL_TASKS, modelKind, modelTask, type BuiltinModel } from '../../core/behavior/models';
import type { BehaviorOp } from '../../core/behavior/ops';
import { validateModels } from '../../core/behavior/validate';
import type { AiModelDoc } from '../../core/types';
import type { Editor } from '../../editor';
import type { ModelStatus } from '../../play/ai/inference';
import type { ComputeBackend } from '../../play/ai/services';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { confirmDialog, toast } from '../overlays';
import { SelectField, TextField, button, row } from '../widgets';
import { fieldRow } from './fields';

export interface ModelsHost {
    editor: Editor;
    locked(): boolean;
    apply(ops: BehaviorOp[], label: string): string[] | null;
}

/** A model's state in a few words. */
export function modelStateText(s: ModelStatus, size?: number): string {
    switch (s.state) {
        case 'ready':
            return `ready (${s.backend === 'webgpu' ? 'GPU' : 'CPU'})`;
        case 'downloading':
            return s.total ? `${Math.round(((s.loaded ?? 0) / s.total) * 100)}%` : `${formatBytes(s.loaded ?? 0)}`;
        case 'loading':
        case 'checking':
            return 'loading...';
        case 'missing':
            return `not downloaded${size ? ` (${formatBytes(size)})` : ''}`;
        case 'lost':
            return 'GPU lost';
        case 'error':
            return 'error';
        default:
            return 'not loaded';
    }
}

export class ModelsEditor {
    readonly el: HTMLElement;
    private list: HTMLElement;
    private detail: HTMLElement;
    private selected: string | null = null;
    /** The Add form is open. */
    private adding = false;
    private key = '';

    constructor(private host: ModelsHost) {
        this.list = h('div', { class: 'bt-memory-list' });
        this.detail = h('div', { class: 'bt-props' });
        const m = host.editor.models;
        const backend = new SelectField<ComputeBackend>(
            [
                { value: 'auto', label: 'GPU when possible' },
                { value: 'wasm', label: 'CPU (WebAssembly)' },
            ],
            m?.backend === 'wasm' ? 'wasm' : 'auto',
            (v) => m?.setBackend(v),
        );
        backend.el.title = 'Where the models run in this browser (the GPU is a device of the worker\'s own; CPU is slower but never competes with the frames).';
        const head = h(
            'div',
            { class: 'bt-keys-head' },
            button('Model', () => this.openAdd(), 'small', 'plus'),
            h('div', { class: 'spacer' }),
            h('span', { class: 'muted small', text: 'Run on', style: { whiteSpace: 'nowrap' } }),
            backend.el,
        );
        this.el = h('div', { class: 'bt-split' }, h('div', { class: 'bt-split-main' }, head, this.list), h('div', { class: 'bt-split-side' }, this.detail));
        m?.on('status', () => this.render());
    }

    private models(): (AiModelDoc | BuiltinModel)[] {
        return allModels(this.host.editor.store.doc.aiModels);
    }

    private status(id: string): ModelStatus {
        return this.host.editor.models?.status(id) ?? { state: 'unknown' };
    }

    render(force = false) {
        const doc = this.host.editor.store.doc;
        const models = this.models();
        const key = JSON.stringify([doc.aiModels, doc.memory.embedder, this.selected, this.adding, this.host.locked(), models.map((m) => this.status(m.id))]);
        if (!force && key === this.key) return;
        this.key = key;
        clear(this.list);
        for (const m of models) {
            const s = this.status(m.id);
            const r = h(
                'div',
                { class: 'bt-memory-row' + (this.selected === m.id && !this.adding ? ' selected' : '') },
                h('span', { class: 'bt-key-name', text: m.id }),
                h('span', { class: 'bt-tag', text: modelTask(m) ?? m.kind }),
                h('span', { class: 'bt-memory-text muted', text: m.name }),
                h('span', { class: 'tree-badge' + (s.state === 'error' || s.state === 'lost' ? ' error' : ''), text: modelStateText(s, 'size' in m ? m.size : undefined), title: s.message ?? '' }),
            );
            r.addEventListener('click', () => {
                this.selected = m.id;
                this.adding = false;
                this.render(true);
            });
            this.list.appendChild(r);
        }
        this.list.appendChild(
            h('div', { class: 'empty-hint', text: `Tasks: ${MODEL_TASKS.map((t) => `${t.label} (${t.usedBy})`).join('; ')}. Add any small ONNX model of a kind below by the URL of its folder (tokenizer.json, config.json and the .onnx file).` }),
        );
        this.renderDetail();
    }

    // ------------------------------------------------------------- detail

    private renderDetail() {
        clear(this.detail);
        if (this.adding) {
            this.detail.appendChild(this.addForm());
            return;
        }
        const m = this.models().find((x) => x.id === this.selected);
        if (!m) {
            this.detail.appendChild(h('div', { class: 'empty-hint', text: 'Select a model, or add one.' }));
            return;
        }
        const builtin = BUILTIN_MODELS.includes(m as BuiltinModel);
        const kind = modelKind(m.kind);
        const body = h('div', { class: 'bt-props-body' });
        if (this.host.locked()) body.setAttribute('inert', '');
        const set = (patch: Record<string, unknown>, label: string) => {
            if (this.host.apply([{ op: 'update_model', model: m.id, set: patch }], label) && typeof patch.id === 'string') this.selected = patch.id;
            this.render(true);
        };
        body.appendChild(h('div', { class: 'inspector-title' }, h('span', { class: 'tree-icon' }, icon('sparkle', 17)), h('span', { class: 'bt-key-name', text: m.name })));
        if (builtin) {
            const b = m as BuiltinModel;
            body.append(
                row('Id', h('div', { class: 'readonly mono', text: b.id })),
                row('Kind', h('div', { class: 'readonly', text: `${kind?.label ?? b.kind} (${kind?.task})` })),
                row('Size', h('div', { class: 'readonly', text: formatBytes(b.size) })),
                row('License', h('div', { class: 'readonly', text: b.license })),
                row('Source', h('a', { text: new URL(b.url).host, attrs: { href: b.homepage, target: '_blank', rel: 'noopener' } })),
            );
        } else {
            const id = new TextField(m.id, (v) => v.trim() && v.trim() !== m.id && set({ id: v.trim() }, 'Rename Model'));
            const name = new TextField(m.name, (v) => v.trim() && set({ name: v.trim() }, 'Model Name'));
            const kinds = new SelectField<string>(MODEL_KINDS.map((k) => ({ value: k.kind, label: `${k.label} (${k.task})` })), m.kind, (v) => set({ kind: v }, 'Model Kind'));
            const url = new TextField(m.url, (v) => set({ url: v }, 'Model URL'), 'https://.../resolve/main/');
            const file = new TextField(m.file, (v) => set({ file: v }, 'Model File'), kind?.file);
            body.append(row('Id', id.el, 'Ask nodes and Model tasks name the model by it.'), row('Name', name.el), row('Kind', kinds.el, kind?.description), row('Folder URL', url.el, 'The folder with tokenizer.json, config.json and the ONNX file.'), row('File', file.el, 'The ONNX file in the folder, or a manifest.json of parts.'));
            // The kind's settings, with its defaults.
            const ctx = { schema: undefined, objects: () => [] };
            for (const f of kind?.options ?? []) {
                const get = () => ({ [f.name]: m.options[f.name] ?? f.default });
                const write = (v: unknown) => set({ options: { ...m.options, [f.name]: v } }, `Model ${f.label}`);
                body.appendChild(fieldRow(f, get, ctx, { commit: write, begin: () => {}, input: () => {}, end: () => {} }).el);
            }
        }
        if (kind && builtin) body.appendChild(h('div', { class: 'muted small pad', text: kind.description }));
        for (const i of validateModels(builtin ? [] : [m as AiModelDoc]).filter((x) => x.model === m.id)) {
            body.appendChild(h('div', { class: 'bt-issue ' + i.severity }, icon('alert', 12), h('span', { text: i.message })));
        }
        body.appendChild(this.statusBox(m));
        const users = this.users(m.id);
        body.appendChild(h('div', { class: 'muted small pad', text: users.length ? `Used by ${users.join('; ')}.` : 'No node uses it yet.' }));
        if (!builtin) {
            body.appendChild(
                h('div', { class: 'inline' }, h('div', { class: 'spacer' }), button('Delete Model', () => {
                    if (this.host.apply([{ op: 'delete_model', model: m.id }], 'Delete Model')) this.selected = null;
                    this.render(true);
                }, 'small danger subtle', 'trash')),
            );
        }
        this.detail.appendChild(body);
    }

    /** State, download and cache buttons. */
    private statusBox(m: AiModelDoc | BuiltinModel): HTMLElement {
        const services = this.host.editor.models;
        const s = this.status(m.id);
        const busy = s.state === 'downloading' || s.state === 'loading' || s.state === 'checking';
        const labels = Array.isArray(s.info?.labels) ? ` Labels: ${(s.info!.labels as string[]).join(', ')}.` : '';
        const box = h('div', { class: 'bt-model-status' }, h('div', { class: 'small', text: `${modelStateText(s, 'size' in m ? m.size : undefined)}${s.message ? `: ${s.message}` : ''}.${labels}` }));
        if (!services) return box;
        const load = button(s.state === 'ready' ? 'Loaded' : 'Download and Load', () => void this.download(m), 'small', 'save');
        load.disabled = busy || s.state === 'ready';
        const check = button('Load from Cache', () => void services.client.load(m, false), 'small subtle', 'refresh');
        check.disabled = busy;
        const forget = button('Remove from Browser', () => void services.forget(m.id), 'small subtle', 'trash');
        forget.disabled = busy;
        box.appendChild(h('div', { class: 'inline' }, load, check, forget));
        return box;
    }

    private async download(m: AiModelDoc | BuiltinModel) {
        const services = this.host.editor.models;
        if (!services) return;
        const size = 'size' in m ? ` (${formatBytes(m.size)})` : '';
        const host = (() => {
            try {
                return new URL(m.url, location.href).host;
            } catch {
                return m.url;
            }
        })();
        if (!(await confirmDialog('Download the model', `${m.name}${size} is downloaded once from ${host} into this browser and runs here; nothing is sent anywhere. Download it now?`, 'Download'))) return;
        const ok = await services.download(m.id);
        toast(ok ? `${m.name} is ready.` : `${m.name} could not be loaded: ${services.status(m.id).message ?? 'unknown error'}`, ok ? 'success' : 'error', 8000);
    }

    /** Trees and nodes that use a model, and the memory. */
    private users(id: string): string[] {
        const doc = this.host.editor.store.doc;
        const out: string[] = [];
        for (const t of doc.behaviors) {
            const nodes: string[] = [];
            const visit = (n: any) => {
                for (const item of [n, ...(n.services ?? [])]) if ((item.type === 'ask' && (item.model || DEFAULT_DECIDE_MODEL) === id) || (item.type === 'infer' && item.model === id)) nodes.push(item.id);
                for (const c of n.children ?? []) visit(c);
            };
            visit(t.root);
            if (nodes.length) out.push(`${t.name}: ${nodes.join(', ')}`);
        }
        if (doc.memory.embedder === id) out.push('the memory');
        return out;
    }

    // ------------------------------------------------------------------ add

    private openAdd() {
        if (this.host.locked()) return;
        this.adding = true;
        this.render(true);
    }

    private addForm(): HTMLElement {
        const draft = { kind: 'classifier', url: '', file: '', name: '', options: {} as Record<string, string | number> };
        const kinds = new SelectField<string>(MODEL_KINDS.map((k) => ({ value: k.kind, label: `${k.label} (${k.task})` })), draft.kind, (v) => {
            draft.kind = v;
            draft.options = {};
            describe();
        });
        const url = new TextField('', (v) => (draft.url = v.trim()), 'https://huggingface.co/<owner>/<model>/resolve/main/');
        const file = new TextField('', (v) => (draft.file = v.trim()), 'onnx/model_quantized.onnx');
        const name = new TextField('', (v) => (draft.name = v.trim()), 'A short name');
        const about = h('div', { class: 'muted small pad' });
        const example = h('div');
        const describe = () => {
            const k = modelKind(draft.kind)!;
            about.textContent = k.description;
            file.el.placeholder = k.file;
            clear(example);
            if (k.example) {
                const ex = k.example;
                example.appendChild(button(`Use ${ex.name}`, () => {
                    url.set(ex.url);
                    draft.url = ex.url;
                    file.set(ex.file ?? '');
                    draft.file = ex.file ?? '';
                    name.set(ex.name);
                    draft.name = ex.name;
                    draft.options = { ...(ex.options ?? {}) };
                }, 'small subtle', 'sparkle'));
            }
        };
        describe();
        const add = () => {
            const model: Record<string, unknown> = { kind: draft.kind, url: draft.url, options: draft.options };
            if (draft.file) model.file = draft.file;
            if (draft.name) model.name = draft.name;
            const r = this.host.editor.applyBehaviorOps([{ op: 'add_model', model }], { label: 'Add Model' });
            if (!r.ok) {
                toast(r.errors[0]?.message ?? 'The model was not added.', 'error', 8000);
                return;
            }
            this.selected = r.created.find((c) => c.kind === 'model')?.id ?? null;
            this.adding = false;
            this.render(true);
        };
        return h(
            'div',
            { class: 'bt-props-body' },
            h('div', { class: 'inspector-title' }, h('span', { class: 'tree-icon' }, icon('plus', 17)), h('span', { text: 'Add a Model' })),
            row('Kind', kinds.el),
            about,
            row('Folder URL', url.el, 'The folder with tokenizer.json, config.json and the ONNX file (on Hugging Face: .../resolve/main/).'),
            row('File', file.el, 'The ONNX file in the folder; empty takes the usual one of the kind.'),
            row('Name', name.el),
            example,
            h('div', { class: 'inline' }, h('div', { class: 'spacer' }), button('Cancel', () => {
                this.adding = false;
                this.render(true);
            }, 'small subtle'), button('Add Model', add, 'small primary', 'plus')),
        );
    }
}
