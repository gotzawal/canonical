import type { Editor } from '../editor';
import { getAssetUrl } from '../core/assets';
import { pickFiles } from '../core/persistence';
import { addConcepts } from './designPanel';
import { clear, h } from './dom';
import { icon } from './icons';
import { toast } from './overlays';

/**
 * The start screen of the pipeline: paste or drop the planning document
 * (.md / .txt) and drop the concept images, then let the assistant decide
 * how the scene is built and structure the rest.
 */
export class BriefScreen {
    readonly el: HTMLElement;
    private text: HTMLTextAreaElement;
    private concepts: HTMLElement;
    private dismissed = false;
    /** Opened by itself for a new project (not by the user). */
    private auto = false;

    constructor(private editor: Editor, private structure: () => void) {
        this.text = h('textarea', {
            class: 'brief-text',
            attrs: { spellcheck: 'true', placeholder: 'Paste the planning document here, or drop .md / .txt files onto this card.' },
        });
        this.text.addEventListener('keydown', (e) => e.stopPropagation());
        this.concepts = h('div', { class: 'brief-concepts' });
        const card = h(
            'div',
            { class: 'brief-card' },
            h(
                'div',
                { class: 'brief-head' },
                icon('open', 18),
                h('h2', { text: 'Start from a plan' }),
                h('div', { class: 'spacer' }),
                h('button', { class: 'icon-btn', title: 'Close', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => this.close() } }, icon('close', 16)),
            ),
            h('p', {
                class: 'brief-intro',
                text: 'Give the planning document and the concept images. The assistant first decides how the scene is built (layout, size, how the areas connect), then structures the areas, specs, mood and play requirements, and asks about anything the plan leaves open.',
            }),
            this.text,
            h('div', { class: 'brief-drop' }, icon('image', 16), h('span', { text: 'Drop concept images here, or' }), this.pickButton()),
            this.concepts,
            h(
                'div',
                { class: 'brief-actions' },
                h('button', { class: 'btn subtle', text: 'Work without a brief', attrs: { type: 'button' }, on: { click: () => this.skip() } }),
                h('div', { class: 'spacer' }),
                h('button', { class: 'btn', text: 'Save brief', attrs: { type: 'button' }, on: { click: () => this.save() && this.close() } }),
                h('button', { class: 'btn primary' }, icon('sparkle', 14), h('span', { text: 'Structure with AI' })),
            ),
        );
        (card.querySelector('.brief-actions .btn.primary') as HTMLElement).addEventListener('click', () => {
            this.save();
            if (!this.editor.store.doc.design.brief.text.trim() && !this.editor.store.doc.design.concepts.length) {
                toast('Paste the brief or add concept images first.', 'info');
                return;
            }
            this.close();
            this.structure();
        });
        this.el = h('div', { class: 'brief-screen', attrs: { hidden: true } }, card);
        card.addEventListener('dragover', (e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault();
            e.stopPropagation();
            card.classList.add('drop-target');
        });
        card.addEventListener('dragleave', (e) => {
            if (!card.contains(e.relatedTarget as Node)) card.classList.remove('drop-target');
        });
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drop-target');
            void this.addFiles(Array.from(e.dataTransfer?.files ?? []));
        });
        this.el.addEventListener('pointerdown', (e) => {
            if (e.target === this.el) this.close();
        });
        const store = editor.store;
        store.on('load', () => {
            this.dismissed = false;
            this.update();
        });
        store.on('change', () => {
            if (this.el.hidden) return;
            this.renderConcepts();
            // The brief was filled in or skipped elsewhere (the Design tab, undo, a loaded file).
            if (this.auto && !this.wanted() && !this.text.value.trim()) this.hide();
        });
        this.update();
    }

    private pickButton(): HTMLElement {
        const b = h('button', { class: 'link-btn', text: 'choose files', attrs: { type: 'button' } });
        b.addEventListener('click', async () => {
            await this.addFiles(await pickFiles('image/*,.md,.markdown,.txt,text/plain,text/markdown', true));
        });
        return b;
    }

    private async addFiles(files: File[]) {
        const images: File[] = [];
        for (const f of files) {
            if (/\.(md|markdown|txt)$/i.test(f.name) || f.type.startsWith('text/')) {
                const text = await f.text();
                this.text.value = this.text.value.trim() ? `${this.text.value.trim()}\n\n${text}` : text;
            } else if (f.type.startsWith('image/')) images.push(f);
            else toast(`${f.name} is neither a text file nor an image.`, 'error');
        }
        if (images.length) await addConcepts(this.editor, images);
        this.renderConcepts();
    }

    private renderConcepts() {
        clear(this.concepts);
        const d = this.editor.store.doc.design;
        for (const c of d.concepts) {
            const meta = this.editor.store.doc.assets.find((a) => a.id === c.asset);
            const img = h('img', { attrs: { alt: meta?.name ?? '' } });
            if (meta) void getAssetUrl(meta).then((url) => url && (img.src = url));
            this.concepts.appendChild(h('div', { class: 'brief-concept', title: meta?.name ?? '' }, img));
        }
    }

    /** Stores the text as the brief; false when there was nothing to store. */
    private save(): boolean {
        const text = this.text.value.replace(/\r\n?/g, '\n').trim();
        const d = this.editor.store.doc.design;
        if (text === d.brief.text) return !!text;
        this.editor.store.commit('Edit Brief', (doc) => {
            doc.design.brief.text = text;
            delete doc.design.brief.skipped;
        }, { design: true });
        return true;
    }

    private skip() {
        this.editor.store.commit('Work Without a Brief', (doc) => {
            doc.design.brief.skipped = true;
        }, { design: true });
        this.close();
    }

    private wanted(): boolean {
        const d = this.editor.store.doc.design;
        return d.stage === 'brief' && !d.brief.text.trim() && !d.brief.skipped && !d.concepts.length && !d.areas.length;
    }

    /** Shows the screen when a new project has no brief yet. */
    update() {
        if (!this.dismissed && this.wanted()) {
            this.open();
            this.auto = true;
        } else if (!this.el.hidden && this.auto) this.hide();
    }

    open() {
        this.auto = false;
        this.text.value = this.editor.store.doc.design.brief.text;
        this.renderConcepts();
        this.el.hidden = false;
        requestAnimationFrame(() => this.text.focus());
    }

    private hide() {
        this.el.hidden = true;
        this.auto = false;
    }

    close() {
        if (this.el.hidden) return;
        this.save();
        this.dismissed = true;
        this.hide();
    }
}
