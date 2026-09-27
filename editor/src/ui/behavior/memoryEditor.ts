// The memory editor: what agents can recall (planning notes, lore, rumors).
// Items have a readable id, tags and a text; Embed computes their vectors
// with the memory's embed model in this browser and stores them in the scene
// (int8), so a built game does not need to embed them again.

import { allModels, modelTask } from '../../core/behavior/models';
import type { BehaviorOp } from '../../core/behavior/ops';
import type { MemoryItemDoc } from '../../core/types';
import type { Editor } from '../../editor';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { confirmDialog } from '../overlays';
import { SelectField, TextAreaField, TextField, button, row } from '../widgets';

export interface MemoryHost {
    editor: Editor;
    locked(): boolean;
    apply(ops: BehaviorOp[], label: string): string[] | null;
    /** Embeds the items without a vector; resolves with a message for the status line. */
    embed(onProgress: (text: string) => void): Promise<string>;
    /** Short state of the embed model for the status line. */
    embedderStatus(): string;
}

export class MemoryEditor {
    readonly el: HTMLElement;
    private list: HTMLElement;
    private detail: HTMLElement;
    private status: HTMLElement;
    private embedderPick: HTMLElement;
    private filter = '';
    private selected: string | null = null;
    private key = '';
    private embedding = false;

    constructor(private host: MemoryHost) {
        this.list = h('div', { class: 'bt-memory-list' });
        this.detail = h('div', { class: 'bt-props' });
        this.status = h('span', { class: 'muted small bt-memory-status' });
        this.embedderPick = h('span', { class: 'bt-embedder' });
        const search = h('input', { class: 'search', attrs: { type: 'search', placeholder: 'Filter by text or tag', spellcheck: 'false' } });
        search.addEventListener('input', () => {
            this.filter = search.value.trim().toLowerCase();
            this.render(true);
        });
        search.addEventListener('keydown', (e) => e.stopPropagation());
        const head = h(
            'div',
            { class: 'bt-keys-head' },
            h('div', { class: 'panel-search inset' }, icon('search', 14), search),
            button('Item', () => this.add(), 'small', 'plus'),
            button('From Brief', () => this.fromBrief(), 'small subtle', 'book'),
            button('Embed', () => void this.embed(), 'small subtle', 'sparkle'),
        );
        this.el = h(
            'div',
            { class: 'bt-split' },
            h('div', { class: 'bt-split-main' }, head, h('div', { class: 'bt-memory-meta' }, this.embedderPick, this.status), this.list),
            h('div', { class: 'bt-split-side' }, this.detail),
        );
    }

    private items(): MemoryItemDoc[] {
        return this.host.editor.store.doc.memory.items;
    }

    render(force = false) {
        const mem = this.host.editor.store.doc.memory;
        const key = JSON.stringify([mem, this.host.editor.store.doc.aiModels, this.selected, this.filter, this.host.locked(), this.embedding]);
        if (!force && key === this.key) return;
        this.key = key;
        const embedded = mem.items.filter((m) => m.vector).length;
        this.renderEmbedder();
        if (!this.embedding) this.status.textContent = `${mem.items.length} item${mem.items.length === 1 ? '' : 's'}, ${embedded} embedded with ${mem.embedder}. ${this.host.embedderStatus()}`;
        clear(this.list);
        const shown = mem.items.filter((m) => !this.filter || m.text.toLowerCase().includes(this.filter) || m.id.toLowerCase().includes(this.filter) || m.tags.some((t) => t.toLowerCase().includes(this.filter)));
        for (const m of shown.slice(0, 500)) {
            const r = h(
                'div',
                { class: 'bt-memory-row' + (this.selected === m.id ? ' selected' : '') },
                h('span', { class: 'bt-key-name', text: m.id }),
                m.tags.length ? h('span', { class: 'bt-tags' }, m.tags.map((t) => h('span', { class: 'bt-tag', text: t }))) : null,
                h('span', { class: 'bt-memory-text muted', text: m.text }),
                m.vector ? null : h('span', { class: 'tree-badge', text: 'not embedded', title: 'Recall ranks it by shared words until it is embedded.' }),
            );
            r.addEventListener('click', () => {
                this.selected = m.id;
                this.render(true);
            });
            this.list.appendChild(r);
        }
        if (!mem.items.length) this.list.appendChild(h('div', { class: 'empty-hint', text: 'Memory is what agents can recall: notes, lore, rumors. Recall services put the best matches into the agent\'s context pool, and an Ask can choose between memory items (the chosen id goes into a string key).' }));
        this.renderDetail();
    }

    /** The embed model the memory's vectors are made with (another one drops them). */
    private renderEmbedder() {
        const doc = this.host.editor.store.doc;
        const models = allModels(doc.aiModels).filter((m) => modelTask(m) === 'embed');
        const opts = models.map((m) => ({ value: m.id, label: `Embed with ${m.name}` }));
        if (!opts.some((o) => o.value === doc.memory.embedder)) opts.push({ value: doc.memory.embedder, label: `${doc.memory.embedder} (missing)` });
        const pick = new SelectField<string>(opts, doc.memory.embedder, async (id) => {
            const vectors = doc.memory.items.some((m) => m.vector);
            if (vectors && !(await confirmDialog('Change the embed model', 'Vectors of different models do not compare: the memory\'s vectors are dropped, and Embed makes them again with the new model.', 'Change'))) {
                this.render(true);
                return;
            }
            this.host.apply([{ op: 'set_memory_vectors', embedder: id, vectors: {} }], 'Embed Model');
            this.render(true);
        });
        pick.el.disabled = this.host.locked();
        pick.el.title = 'Recall and memory choices compare queries and items with this model (Models view).';
        this.embedderPick.replaceChildren(pick.el);
    }

    private renderDetail() {
        clear(this.detail);
        const m = this.items().find((x) => x.id === this.selected);
        if (!m) {
            this.detail.appendChild(h('div', { class: 'empty-hint', text: 'Select an item to edit it.' }));
            return;
        }
        const body = h('div', { class: 'bt-props-body' });
        if (this.host.locked()) body.setAttribute('inert', '');
        const set = (patch: Record<string, unknown>, label: string) => {
            if (this.host.apply([{ op: 'update_memory', item: m.id, set: patch }], label) && typeof patch.id === 'string') this.selected = patch.id;
            this.render(true);
        };
        const id = new TextField(m.id, (v) => v.trim() && v.trim() !== m.id && set({ id: v.trim() }, 'Rename Memory'));
        id.el.classList.add('name-input');
        const tags = new TextField(m.tags.join(', '), (v) => set({ tags: v.split(',').map((t) => t.trim()).filter(Boolean) }, 'Memory Tags'), 'rumor, lore');
        const text = new TextAreaField(m.text, (v) => v.trim() && set({ text: v }, 'Memory Text'), 'What the agent knows', 6);
        body.append(
            h('div', { class: 'inspector-title' }, h('span', { class: 'tree-icon' }, icon('book', 17)), id.el),
            row('Tags', tags.el),
            row('Text', text.el),
            h('div', { class: 'muted small pad', text: m.vector ? 'Embedded.' : 'Not embedded yet: use Embed. Changing the text drops the embedding.' }),
            h('div', { class: 'inline' }, h('div', { class: 'spacer' }), button('Delete Item', () => {
                if (this.host.apply([{ op: 'delete_memory', item: m.id }], 'Delete Memory')) this.selected = null;
                this.render(true);
            }, 'small danger subtle', 'trash')),
        );
        this.detail.appendChild(body);
    }

    private add() {
        if (this.host.locked()) return;
        const created = this.host.apply([{ op: 'add_memory', item: { text: 'New memory.', tags: [] } }], 'Add Memory');
        if (created?.length) {
            this.selected = created[0];
            this.render(true);
        }
    }

    /** Paragraphs of the planning brief as memory items tagged "brief". */
    private fromBrief() {
        if (this.host.locked()) return;
        const text = this.host.editor.store.doc.design.brief.text;
        const paragraphs = text
            .split(/\n\s*\n/)
            .map((p) => p.replace(/\s+/g, ' ').trim())
            .filter((p) => p.length > 20);
        const existing = new Set(this.items().map((m) => m.text));
        const ops: BehaviorOp[] = paragraphs.filter((p) => !existing.has(p.slice(0, 4000))).slice(0, 500).map((p) => ({ op: 'add_memory', item: { text: p, tags: ['brief'] } }));
        if (!ops.length) {
            this.status.textContent = text.trim() ? 'Every paragraph of the brief is in memory already.' : 'The planning brief is empty (Design tab).';
            return;
        }
        this.host.apply(ops, 'Memory from Brief');
        this.render(true);
    }

    private async embed() {
        if (this.embedding || this.host.locked()) return;
        this.embedding = true;
        try {
            this.status.textContent = await this.host.embed((t) => (this.status.textContent = t));
        } catch (e: any) {
            this.status.textContent = `Embedding failed: ${e?.message || e}`;
        } finally {
            this.embedding = false;
            this.key = '';
            const msg = this.status.textContent;
            this.render(true);
            this.status.textContent = msg;
        }
    }
}
