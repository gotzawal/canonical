// The Behavior tab of the dock: behavior trees as an outliner with the
// selected node's properties, the blackboard schema, the memory, and while
// playing a debug view (the chosen agent's active path, blackboard and the
// latest answers). Every edit goes through the edit operation layer.

import { formatBytes } from '../../core/assets';
import { findNode } from '../../core/behavior/format';
import { formatValue } from '../../core/behavior/nodeTypes';
import type { BehaviorOp } from '../../core/behavior/ops';
import { describeIssue, validateSchema, validateTree, type Issue } from '../../core/behavior/validate';
import type { BehaviorTreeDoc, BlackboardSchemaDoc } from '../../core/types';
import type { Editor } from '../../editor';
import type { Agent } from '../../play/ai/agents';
import { encodeVector } from '../../play/ai/memory';
import { modelSource } from '../../play/ai/models';
import { answerText } from '../decisionLogPanel';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { confirmDialog, showMenu, toast, type MenuItem } from '../overlays';
import { SelectField, TextField, button, iconButton } from '../widgets';
import { MemoryEditor } from './memoryEditor';
import { Outliner, type FocusPart } from './outliner';
import { PropertiesPanel } from './properties';
import { SchemaEditor } from './schemaEditor';

type Mode = 'tree' | 'schema' | 'memory';

const STATE_KEY = 'canonical-editor/behavior';

export class BehaviorPanel {
    readonly el: HTMLElement;
    private mode: Mode = 'tree';
    private treeId: string | null = null;
    private part: FocusPart = null;
    private outliner: Outliner;
    private props: PropertiesPanel;
    private schemaEditor: SchemaEditor;
    private memoryEditor: MemoryEditor;
    private body: HTMLElement;
    private side: HTMLElement;
    private debugEl: HTMLElement;
    private toolbar: HTMLElement;
    private modelChip: HTMLElement;
    private visible = false;
    private agentId: string | null = null;
    private timer = 0;
    private issueCache: { key: string; issues: Issue[] } = { key: '', issues: [] };

    constructor(private editor: Editor) {
        const host = {
            tree: () => this.tree(),
            schema: () => this.schema(),
            issues: () => this.issues(),
            locked: () => this.locked(),
            debug: () => this.debugState(),
        };
        this.outliner = new Outliner({
            ...host,
            apply: (ops, label) => this.apply(ops, label),
            selected: (ids, part) => {
                this.part = part;
                this.props.render();
                this.save();
            },
        });
        this.props = new PropertiesPanel({
            ...host,
            editor,
            node: () => {
                const t = this.tree();
                const id = this.outliner.primary;
                return t && id ? findNode(t, id)?.node : undefined;
            },
            part: () => this.part,
            apply: (ops, label) => this.apply(ops, label),
            renamed: (from, to) => {
                this.outliner.selection = this.outliner.selection.map((x) => (x === from ? to : x));
                this.outliner.render(true);
                this.props.render();
            },
            focusPart: (part) => {
                this.part = part;
                this.props.render();
            },
        });
        this.schemaEditor = new SchemaEditor({ ...host, editor, apply: (ops, label) => !!this.apply(ops, label) });
        this.memoryEditor = new MemoryEditor({
            editor,
            locked: () => this.locked(),
            apply: (ops, label) => this.apply(ops, label),
            embed: (onProgress) => this.embedMemory(onProgress),
            embedderStatus: () => this.embedderText(),
        });
        this.debugEl = h('div', { class: 'bt-debug' });
        this.side = h('div', { class: 'bt-split-side' });
        this.body = h('div', { class: 'bt-body' });
        this.modelChip = h('button', { class: 'bt-model-chip', attrs: { type: 'button' } });
        this.modelChip.addEventListener('click', (e) => this.modelMenu(e));
        this.toolbar = h('div', { class: 'graph-toolbar bt-toolbar' });
        this.el = h('div', { class: 'bt-panel' }, this.toolbar, this.body);

        const store = editor.store;
        store.on('change', () => this.refresh());
        store.on('load', () => {
            this.treeId = null;
            this.outliner.select([]);
            this.restore();
            this.render();
        });
        editor.player.on('state', (st) => {
            if (st === 'stopped') this.agentId = null;
            this.render();
            this.loop();
        });
        editor.on('show-behavior', (t) => {
            if (t.tree && store.doc.behaviors.some((x) => x.id === t.tree)) this.treeId = t.tree;
            if (t.schema) this.mode = 'schema';
            else this.mode = 'tree';
            if (t.node) this.outliner.selection = [t.node];
            this.render();
        });
        editor.models?.on('status', () => this.renderToolbar());
        this.restore();
        this.render();
    }

    /** The dock calls this when the tab is shown or hidden. */
    setVisible(v: boolean) {
        this.visible = v;
        if (v) this.render();
        this.loop();
    }

    // ------------------------------------------------------------ state

    tree(): BehaviorTreeDoc | undefined {
        const list = this.editor.store.doc.behaviors;
        return list.find((t) => t.id === this.treeId) ?? list[0];
    }

    schema(): BlackboardSchemaDoc | undefined {
        const t = this.tree();
        return t ? this.editor.store.doc.blackboards.find((s) => s.id === t.schema) : undefined;
    }

    private locked(): boolean {
        return this.editor.player.state !== 'stopped';
    }

    private issues(): Issue[] {
        const doc = this.editor.store.doc;
        const t = this.tree();
        const s = this.schema();
        const key = JSON.stringify([t, s, doc.memory.items.length]);
        if (key !== this.issueCache.key) {
            this.issueCache = { key, issues: [...(t ? validateTree(t, doc.blackboards, doc.memory) : []), ...(s ? validateSchema(s) : [])] };
        }
        return this.issueCache.issues;
    }

    private apply(ops: BehaviorOp[], label: string): string[] | null {
        const r = this.editor.applyBehaviorOps(ops, { label });
        if (!r.ok) {
            const e = r.errors[0];
            toast(e ? `${e.node ? `${e.node}: ` : ''}${e.message}` : 'The change was refused.', 'error', 6000);
            return null;
        }
        return r.created.filter((c) => c.kind === 'node' || c.kind === 'service' || c.kind === 'memory').map((c) => c.id);
    }

    private save() {
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify({ tree: this.treeId, mode: this.mode }));
        } catch { /* ignore */ }
    }

    private restore() {
        try {
            const s = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
            if (typeof s.tree === 'string') this.treeId = s.tree;
            if (s.mode === 'tree' || s.mode === 'schema' || s.mode === 'memory') this.mode = s.mode;
        } catch { /* ignore */ }
    }

    // ---------------------------------------------------------- rendering

    private refresh() {
        if (!this.visible) return;
        this.renderToolbar();
        if (this.mode === 'tree') {
            this.outliner.prune();
            this.outliner.render();
            this.props.refresh();
        } else if (this.mode === 'schema') this.schemaEditor.render();
        else this.memoryEditor.render();
    }

    render() {
        if (!this.visible) return;
        this.renderToolbar();
        clear(this.body);
        if (this.mode === 'tree') {
            clear(this.side);
            this.side.appendChild(this.locked() ? this.debugEl : this.props.el);
            this.body.appendChild(h('div', { class: 'bt-split' }, h('div', { class: 'bt-split-main' }, this.outliner.el), this.side));
            this.outliner.render(true);
            if (this.locked()) this.renderDebug();
            else this.props.render();
        } else if (this.mode === 'schema') {
            this.body.appendChild(this.schemaEditor.el);
            this.schemaEditor.render(true);
        } else {
            this.body.appendChild(this.memoryEditor.el);
            this.memoryEditor.render(true);
        }
    }

    private renderToolbar() {
        const doc = this.editor.store.doc;
        const t = this.tree();
        clear(this.toolbar);
        const tabs = h(
            'div',
            { class: 'bt-modes', attrs: { role: 'tablist' } },
            (
                [
                    ['tree', 'Tree', 'behavior'],
                    ['schema', 'Blackboard', 'key'],
                    ['memory', 'Memory', 'book'],
                ] as [Mode, string, string][]
            ).map(([m, label, ic]) => {
                const b = h('button', { class: 'bt-mode' + (this.mode === m ? ' active' : ''), attrs: { type: 'button', role: 'tab' } }, icon(ic, 13), h('span', { text: label }));
                b.addEventListener('click', () => {
                    this.mode = m;
                    this.save();
                    this.render();
                });
                return b;
            }),
        );
        this.toolbar.append(tabs);
        if (this.mode !== 'memory') {
            if (doc.behaviors.length) {
                const pick = new SelectField(doc.behaviors.map((x) => ({ value: x.id, label: x.name })), t?.id ?? '', (id) => {
                    this.treeId = id;
                    this.outliner.select([]);
                    this.save();
                    this.render();
                });
                pick.el.classList.add('bt-tree-pick');
                pick.el.title = 'Behavior tree';
                this.toolbar.append(pick.el);
            }
            if (t) {
                const schemas = doc.blackboards.map((s) => ({ value: s.id, label: `Blackboard: ${s.name}` }));
                if (!doc.blackboards.some((s) => s.id === t.schema)) schemas.unshift({ value: t.schema, label: 'Blackboard: (missing)' });
                const schema = new SelectField(schemas, t.schema, (id) => this.apply([{ op: 'update_tree', tree: t.id, schema: id }], 'Tree Schema'));
                schema.el.title = 'The blackboard schema this tree uses';
                if (this.locked()) schema.el.disabled = true;
                this.toolbar.append(schema.el);
            }
        }
        const issues = this.mode === 'memory' ? [] : this.issues();
        const errors = issues.filter((i) => i.severity === 'error').length;
        const warnings = issues.length - errors;
        if (t && this.mode !== 'memory') {
            const chip = h('span', { class: 'bt-valid ' + (errors ? 'error' : warnings ? 'warning' : 'ok'), title: issues.map((i) => describeIssue(i)).join('\n') || 'No problems' }, icon(errors || warnings ? 'alert' : 'check', 12), h('span', { text: errors || warnings ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'Valid' }));
            this.toolbar.append(chip);
        }
        this.toolbar.append(h('div', { class: 'spacer' }));
        this.renderModelChip();
        this.toolbar.append(this.modelChip);
        if (t && this.mode === 'tree') {
            const users = doc.nodes.filter((n) => n.agent?.tree === t.id).length;
            const assign = button(`Assign${users ? ` (${users})` : ''}`, () => this.assign(t), 'small', 'agent');
            assign.title = 'Make the selected objects run this tree';
            if (this.locked()) assign.disabled = true;
            this.toolbar.append(assign, iconButton('code', 'Edit as JSON', () => this.editor.emit('open-code', { kind: 'behavior', id: t.id })));
        }
        const more = iconButton('dots', 'Behavior tree options', (e) => this.treeMenu(e));
        const add = iconButton('plus', 'New behavior tree', () => this.newTree());
        if (this.locked()) add.disabled = true;
        this.toolbar.append(add, more);
    }

    private renderModelChip() {
        const m = this.editor.models;
        if (!m) {
            this.modelChip.hidden = true;
            return;
        }
        const s = m.status('decision');
        let text = '';
        let cls = '';
        switch (s.state) {
            case 'ready':
                text = `Laya ready (${s.backend === 'webgpu' ? 'WebGPU' : 'WASM'})`;
                cls = 'ok';
                break;
            case 'downloading':
                text = `Laya ${Math.round(((s.loaded ?? 0) / Math.max(1, s.total ?? 1)) * 100)}%`;
                cls = 'busy';
                break;
            case 'loading':
            case 'checking':
                text = 'Laya loading...';
                cls = 'busy';
                break;
            case 'missing':
                text = `Laya not downloaded (${formatBytes(s.source.size)})`;
                cls = 'warn';
                break;
            case 'error':
            case 'lost':
                text = s.state === 'lost' ? 'Laya: GPU lost' : 'Laya: error';
                cls = 'error';
                break;
            default:
                text = 'Laya not loaded';
        }
        this.modelChip.hidden = false;
        this.modelChip.className = 'bt-model-chip ' + cls;
        this.modelChip.replaceChildren(icon('sparkle', 12), h('span', { text }));
        this.modelChip.title = [s.source.label, s.source.license, s.message ?? ''].filter(Boolean).join('\n');
    }

    private modelMenu(e: MouseEvent) {
        const m = this.editor.models;
        if (!m) return;
        const s = m.status('decision');
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const items: MenuItem[] = [
            { label: `${s.source.label}`, enabled: () => false },
            { label: `Download (${formatBytes(s.source.size)})`, icon: 'save', enabled: () => s.state !== 'ready' && s.state !== 'downloading' && s.state !== 'loading', action: () => void this.downloadDecision() },
            { label: 'Check this Browser\'s Copy', icon: 'refresh', enabled: () => s.state !== 'downloading' && s.state !== 'loading', action: () => void m.client.load('decision', false) },
            { separator: true },
            { label: 'Run on the GPU when possible', checked: () => m.backend === 'auto', action: () => m.setBackend('auto') },
            { label: 'Run on the CPU (WebAssembly)', checked: () => m.backend === 'wasm', action: () => m.setBackend('wasm') },
            { separator: true },
            { label: 'Remove from this Browser', icon: 'trash', enabled: () => s.state === 'ready' || s.state === 'missing' || s.state === 'error', action: () => void m.client.forget('decision') },
        ];
        showMenu(items, r.right - 260, r.bottom + 4);
    }

    async downloadDecision() {
        const m = this.editor.models;
        if (!m) return;
        const s = m.status('decision');
        if (!(await confirmDialog('Download the decision model', `Agents ask ${s.source.label} (${formatBytes(s.source.size)}, ${s.source.license}). It is downloaded once from ${new URL(s.source.base).host} into this browser and runs here; nothing is sent anywhere. Download it now?`, 'Download'))) return;
        const ok = await m.download('decision');
        toast(ok ? 'The decision model is ready.' : `The decision model could not be loaded: ${m.status('decision').message ?? 'unknown error'}`, ok ? 'success' : 'error', 6000);
    }

    private embedderText(): string {
        const m = this.editor.models;
        if (!m) return '';
        // The scene's memory decides the model (vectors of different models do not compare).
        const id = this.editor.store.doc.memory.embedder;
        const src = modelSource(id, 'embedder');
        if (!src) return `Unknown embedding model "${id}".`;
        const s = m.status('embedder');
        if (s.source.id === src.id) {
            if (s.state === 'ready') return `Embedding model ready (${s.backend === 'webgpu' ? 'WebGPU' : 'WASM'}).`;
            if (s.state === 'downloading') return `Downloading the embedding model: ${Math.round(((s.loaded ?? 0) / Math.max(1, s.total ?? 1)) * 100)}%.`;
            if (s.state === 'error') return `Embedding model: ${s.message ?? 'error'}.`;
        }
        return `Embed downloads ${src.label} (${formatBytes(src.size)}) once.`;
    }

    // ------------------------------------------------------------- actions

    private newTree() {
        if (this.locked()) return;
        const id = this.editor.newBehaviorTree({ schema: this.schema()?.id });
        if (!id) return;
        this.treeId = id;
        this.mode = 'tree';
        this.outliner.select(['root']);
        this.save();
        this.render();
    }

    private assign(t: BehaviorTreeDoc) {
        const ids = this.editor.store.selection;
        if (!ids.length) {
            toast('Select the objects that should run this tree first.', 'info');
            return;
        }
        this.apply(ids.map((id) => ({ op: 'set_agent', object: id, tree: t.id, enabled: true })), 'Assign Behavior Tree');
        toast(`${ids.length} object${ids.length === 1 ? '' : 's'} now run${ids.length === 1 ? 's' : ''} ${t.name}.`, 'success');
    }

    private treeMenu(e: MouseEvent) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const t = this.tree();
        const s = this.schema();
        const unlocked = () => !this.locked();
        const items: MenuItem[] = [
            { label: 'New Behavior Tree', icon: 'plus', enabled: unlocked, action: () => this.newTree() },
            {
                label: 'New Blackboard Schema',
                icon: 'key',
                enabled: unlocked,
                action: () => {
                    const doc = this.editor.store.doc;
                    let n = doc.blackboards.length + 1;
                    const names = new Set(doc.blackboards.map((x) => x.name.toLowerCase()));
                    while (names.has(`blackboard ${n}`)) n++;
                    if (this.apply([{ op: 'create_schema', name: `Blackboard ${n}` }], 'New Blackboard Schema')) toast(`Created "Blackboard ${n}". Pick it for a tree in the toolbar.`, 'success');
                },
            },
            { separator: true },
            { label: 'Rename Tree...', enabled: () => unlocked() && !!t, action: () => t && this.rename('tree', t.id, t.name) },
            { label: 'Rename Blackboard...', enabled: () => unlocked() && !!s, action: () => s && this.rename('schema', s.id, s.name) },
            { label: 'Duplicate Tree', icon: 'copy', enabled: () => unlocked() && !!t, action: () => t && this.duplicateTree(t) },
            { separator: true },
            { label: 'Delete Tree', icon: 'trash', enabled: () => unlocked() && !!t, action: () => t && void this.deleteTree(t) },
            { label: 'Delete Blackboard', icon: 'trash', enabled: () => unlocked() && !!s, action: () => s && this.apply([{ op: 'delete_schema', schema: s.id }], 'Delete Blackboard') },
        ];
        showMenu(items, r.right - 220, r.bottom + 4);
    }

    private rename(kind: 'tree' | 'schema', id: string, current: string) {
        const field = new TextField(current, () => {});
        const box = h('div', { class: 'bt-rename' }, field.el);
        const commit = () => {
            const name = field.el.value.trim();
            if (name && name !== current) this.apply([kind === 'tree' ? { op: 'update_tree', tree: id, name } : { op: 'update_schema', schema: id, name }], kind === 'tree' ? 'Rename Tree' : 'Rename Blackboard');
            box.remove();
            this.render();
        };
        field.el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
                box.remove();
            }
        });
        field.el.addEventListener('blur', commit);
        this.toolbar.prepend(box);
        field.el.focus();
        field.el.select();
    }

    private duplicateTree(t: BehaviorTreeDoc) {
        const names = new Set(this.editor.store.doc.behaviors.map((x) => x.name.toLowerCase()));
        let name = `${t.name} Copy`;
        for (let i = 2; names.has(name.toLowerCase()); i++) name = `${t.name} Copy ${i}`;
        const r = this.editor.applyBehaviorOps([{ op: 'create_tree', name, schema: t.schema, root: JSON.parse(JSON.stringify(t.root)) }], { label: 'Duplicate Tree' });
        if (!r.ok) toast(r.errors[0]?.message ?? 'Could not duplicate the tree.', 'error');
        else {
            this.treeId = r.created.find((c) => c.kind === 'tree')?.id ?? this.treeId;
            this.render();
        }
    }

    private async deleteTree(t: BehaviorTreeDoc) {
        const doc = this.editor.store.doc;
        const users = [
            ...doc.nodes.filter((n) => n.agent?.tree === t.id).map((n) => n.name),
            ...doc.prefabs.flatMap((p) => p.nodes.filter((n) => n.agent?.tree === t.id).map((n) => `${n.name} (in prefab ${p.name})`)),
        ];
        if (users.length && !(await confirmDialog('Delete behavior tree', `${t.name} runs on ${users.join(', ')}. Delete it and remove their agents?`, 'Delete', true))) return;
        if (this.apply([{ op: 'delete_tree', tree: t.id, force: true }], 'Delete Tree')) {
            this.treeId = null;
            this.outliner.select([]);
            this.render();
        }
    }

    /** Embeds the memory items that have no vector yet (downloads the embedding model the first time). */
    private async embedMemory(onProgress: (text: string) => void): Promise<string> {
        const m = this.editor.models;
        if (!m) return 'Models are not available here.';
        const doc = this.editor.store.doc;
        const src = m.use('embedder', doc.memory.embedder);
        if (!src) return `Unknown embedding model "${doc.memory.embedder}".`;
        const todo = doc.memory.items.filter((x) => !x.vector);
        if (!todo.length) return 'Every item is embedded.';
        if (!m.embedderReady) {
            const cached = await m.client.cached('embedder');
            if (!cached && !(await confirmDialog('Download the embedding model', `Embedding needs ${src.label} (${formatBytes(src.size)}, ${src.license}), downloaded once from ${new URL(src.base).host} into this browser. Download it now?`, 'Download'))) return 'Not embedded: the embedding model was not downloaded.';
            onProgress('Loading the embedding model...');
            if (!(await m.download('embedder'))) return `The embedding model could not be loaded: ${m.status('embedder').message ?? 'unknown error'}`;
        }
        // Each vector goes with the text it was made from: an item edited meanwhile keeps no stale vector.
        const vectors: Record<string, { text: string; vector: string }> = {};
        const chunk = 32;
        for (let i = 0; i < todo.length; i += chunk) {
            const part = todo.slice(i, i + chunk);
            const vs = await m.client.embed(part.map((x) => x.text), 'passage');
            part.forEach((x, j) => (vectors[x.id] = { text: x.text, vector: encodeVector(vs[j]) }));
            onProgress(`Embedded ${Math.min(i + chunk, todo.length)} of ${todo.length}...`);
        }
        const r = this.editor.applyBehaviorOps([{ op: 'set_memory_vectors', embedder: src.id, vectors }], { label: 'Embed Memory' });
        return r.ok ? `Embedded ${todo.length} item${todo.length === 1 ? '' : 's'}.` : r.errors[0]?.message ?? 'Could not store the vectors.';
    }

    // ---------------------------------------------------------------- debug

    private agents(): Agent[] {
        const t = this.tree();
        return this.editor.player.agents.agents.filter((a) => a.treeDoc.id === t?.id);
    }

    private agent(): Agent | undefined {
        const list = this.agents();
        const sel = this.editor.store.primary?.id;
        return list.find((a) => a.id === this.agentId) ?? list.find((a) => a.id === sel) ?? list[0];
    }

    private debugState() {
        if (!this.locked()) return null;
        const a = this.agent();
        return a ? a.tree.debug() : null;
    }

    private loop() {
        clearInterval(this.timer);
        if (!this.visible || !this.locked()) return;
        this.timer = window.setInterval(() => {
            if (this.mode !== 'tree') return;
            this.outliner.render();
            this.renderDebug();
        }, 200);
    }

    private renderDebug() {
        const el = this.debugEl;
        const list = this.agents();
        const agent = this.agent();
        clear(el);
        if (!list.length) {
            el.appendChild(h('div', { class: 'empty-hint', text: 'No object runs this tree in this Play session.' }));
            return;
        }
        const pick = new SelectField(list.map((a) => ({ value: a.id, label: a.name })), agent?.id ?? '', (id) => {
            this.agentId = id;
            this.renderDebug();
            this.outliner.render(true);
        });
        el.appendChild(h('div', { class: 'bt-debug-head' }, icon('agent', 14), pick.el, h('span', { class: 'muted small', text: agent ? `${agent.tree.ticks} ticks` : '' })));
        if (!agent) return;
        const dbg = this.editor.player.agents.debug(agent);
        const now = this.editor.player.time.elapsed;
        const rows = agent.blackboard.keys.map((k) => {
            const a = dbg.answers[k.name];
            return h(
                'tr',
                { class: a ? 'answered' : '' },
                h('td', null, h('span', { class: 'bt-owner ' + k.owner, text: k.owner })),
                h('td', { class: 'mono', text: k.name }),
                h('td', { class: 'mono', text: formatValue(dbg.values[k.name]) }),
                h('td', { class: 'muted', text: `v${dbg.versions[k.name]}` }),
                h('td', { class: 'muted', text: a ? `${Math.round(a.confidence * 100)}% ${a.source} ${Math.max(0, now - a.at).toFixed(1)}s ago` : k.owner === 'ai' ? 'default' : '' }),
            );
        });
        el.appendChild(h('table', { class: 'bt-bb-table' }, h('tr', null, h('th', null, ''), h('th', { text: 'Key' }), h('th', { text: 'Value' }), h('th', { text: 'Ver' }), h('th', { text: 'Answer' })), rows));
        if (dbg.context) el.appendChild(h('div', { class: 'muted small pad', text: `Context from ${dbg.context.by}: ${dbg.context.ids.join(', ') || 'nothing matched'}` }));
        const stats = this.editor.models?.scheduler.stats();
        const log = this.editor.player.agents.log;
        const mine = log.entries.filter((e) => e.agent === agent.id);
        const lastAnswers = mine.slice(-4).reverse();
        if (lastAnswers.length) {
            el.appendChild(h('div', { class: 'bt-group-title' }, h('span', { text: 'Latest answers' })));
            for (const e of lastAnswers) {
                el.appendChild(h('div', { class: 'bt-answer' }, h('span', { class: 'mono', text: `${e.node}#${e.seq}` }), h('span', { text: e.questions.map((q) => `${answerText(q)} ${q.outcome.replace('_', ' ')}`).join(', ') }), h('span', { class: 'muted', text: `${e.time.toFixed(1)}s` })));
            }
        }
        if (stats) el.appendChild(h('div', { class: 'muted small pad', text: `Scheduler: ${stats.queued} waiting (${stats.questions} questions), ${stats.inFlight ? 'a batch running' : 'idle'}, budget ${stats.budget} ms/s, ${stats.batches} batches, ${stats.cacheHits} cache hits` }));
    }
}
