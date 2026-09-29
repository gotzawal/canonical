import type { Attachment } from '../ai/agent';
import { putDesignImage } from '../core/assets';
import { planStarted } from '../core/design';
import { readLocal, writeLocal } from '../core/local';
import { pickFiles } from '../core/persistence';
import type { AssetMeta } from '../core/types';
import type { Editor } from '../editor';
import { onChanges, touches } from './batch';
import { clear, h } from './dom';
import { icon } from './icons';
import { mascotPose } from './mascot';
import { toast } from './overlays';

/** Projects whose start screen was closed without a request (this browser; the latest ones). */
const DISMISSED_KEY = 'canonical-editor/start-dismissed';
const KEEP_DISMISSED = 100;

/** The dismissed projects' ids (damaged storage reads as none). */
function dismissedList(): string[] {
    const list = readLocal<unknown>(DISMISSED_KEY, []);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

const IDEAS = [
    'A cozy cabin by a lake at dusk, with a jetty and a campfire',
    'A small castle courtyard with a well, market stalls and a gate',
    'A narrow neon alley in the rain, with shop signs and puddles',
];

export interface StartHooks {
    /**
     * The user said what to make: its brief (and reference images) are in
     * the project now; the assistant starts on it. `fresh`: the scene is
     * still the new scene's sample (a cube and a sphere on the ground).
     */
    start(request: string, images: Attachment[], fresh: boolean): void;
}

/** A file waiting on the start screen until the user starts. */
interface Pending {
    file: File;
    /** Text of a planning document; images have none. */
    text?: string;
    url?: string;
}

/**
 * The start of a project: one question, "What shall we make?". The answer
 * is the brief; a planning document or reference images can go into the
 * same box but are not needed. The assistant then plans and builds it.
 */
export class StartScreen {
    readonly el: HTMLElement;
    private input: HTMLTextAreaElement;
    private files: HTMLElement;
    private card: HTMLElement;
    private pending: Pending[] = [];
    private startBtn: HTMLButtonElement;
    /** Closed in this session (a new project asks again). */
    private closedFor = '';

    constructor(private editor: Editor, private hooks: StartHooks) {
        this.input = h('textarea', {
            class: 'start-input',
            attrs: { rows: 3, spellcheck: 'true', placeholder: 'A cozy cabin by a lake at dusk, a castle courtyard, a neon alley in the rain...', 'aria-label': 'What shall we make?' },
        });
        this.input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void this.submit();
            } else if (e.key === 'Escape' && !e.isComposing) this.close();
        });
        this.input.addEventListener('input', () => this.renderButton());
        this.input.addEventListener('paste', (e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length) return;
            e.preventDefault();
            void this.addFiles(files);
        });
        this.files = h('div', { class: 'start-files', attrs: { hidden: true } });
        const attach = h('button', { class: 'btn subtle small start-attach', title: 'A planning document (.md, .txt) or reference images; or drop them here', attrs: { type: 'button' } }, icon('attach', 14), h('span', { text: 'Add a document or images' }));
        attach.addEventListener('click', async () => void this.addFiles(await pickFiles('image/*,.md,.markdown,.txt,text/plain,text/markdown', true)));
        this.startBtn = h('button', { class: 'btn primary start-go', attrs: { type: 'button' } }, icon('sparkle', 14), h('span', { text: 'Start' }));
        this.startBtn.addEventListener('click', () => void this.submit());
        const composer = h('div', { class: 'start-composer' }, this.input, this.files, h('div', { class: 'start-row' }, attach, h('div', { class: 'spacer' }), this.startBtn));
        const ideas = h(
            'div',
            { class: 'start-ideas' },
            IDEAS.map((idea) => {
                const b = h('button', { class: 'start-idea', text: idea, attrs: { type: 'button' } });
                b.addEventListener('click', () => {
                    this.input.value = idea;
                    this.renderButton();
                    this.input.focus();
                });
                return b;
            }),
        );
        this.card = h(
            'div',
            { class: 'start-card', attrs: { role: 'dialog', 'aria-label': 'Start a scene' } },
            h('button', { class: 'icon-btn start-close', title: 'Not now', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => this.close() } }, icon('close', 16)),
            // The heron asks, standing on the box the answer goes into.
            h(
                'div',
                { class: 'start-head' },
                mascotPose('ask', 172, 'start-heron'),
                h(
                    'div',
                    { class: 'start-text' },
                    h('h2', { class: 'start-title', text: 'What shall we make?' }),
                    h('p', { class: 'start-sub', text: 'Describe a place or a scene in your own words. The assistant plans it, builds it and shows you the result; you say what you like and what to change.' }),
                ),
            ),
            composer,
            ideas,
        );
        this.el = h('div', { class: 'start-screen', attrs: { hidden: true } }, this.card);
        this.card.addEventListener('dragover', (e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault();
            e.stopPropagation();
            this.card.classList.add('drop-target');
        });
        this.card.addEventListener('dragleave', (e) => {
            if (!this.card.contains(e.relatedTarget as Node)) this.card.classList.remove('drop-target');
        });
        this.card.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.card.classList.remove('drop-target');
            void this.addFiles(Array.from(e.dataTransfer?.files ?? []));
        });
        this.el.addEventListener('pointerdown', (e) => {
            if (e.target === this.el) this.close();
        });
        const store = editor.store;
        store.on('load', () => {
            // What the screen holds belongs to the previous project.
            this.reset();
            this.update();
        });
        // Play shows the game: the screen steps aside and comes back at Stop, text kept.
        let stepAside = false;
        store.on('playing', (playing) => {
            if (playing && !this.el.hidden) {
                stepAside = true;
                this.el.hidden = true;
            } else if (!playing && stepAside) {
                stepAside = false;
                this.update();
            }
        });
        // The chat, a loaded file or undo can start (or un-start) the project too.
        onChanges(store, (hint) => touches(hint, 'design') && this.update());
        this.renderButton();
        this.update();
    }

    /** The project has not started and the user has not closed this screen for it. */
    private wanted(): boolean {
        const d = this.editor.store.doc.design;
        if (planStarted(d) || d.brief.skipped || this.closedFor === d.id) return false;
        return !dismissedList().includes(d.id);
    }

    /** Shows the screen for a project that has not started, and hides it once it has. */
    update() {
        const show = this.wanted() && !this.editor.store.playing;
        if (show === !this.el.hidden) return;
        this.el.hidden = !show;
        if (show) requestAnimationFrame(() => this.input.focus());
    }

    /** Closes the screen; the project does not ask again (the chat takes the first request instead). */
    close() {
        this.dismiss();
        this.el.hidden = true;
    }

    /** Remembers that this project needs no start screen (it was closed, or the chat started it). */
    dismiss() {
        const id = this.editor.store.doc.design.id;
        this.closedFor = id;
        const list = dismissedList().filter((x) => x !== id);
        list.push(id);
        writeLocal(DISMISSED_KEY, list.slice(-KEEP_DISMISSED));
    }

    private reset() {
        this.input.value = '';
        for (const p of this.pending) if (p.url) URL.revokeObjectURL(p.url);
        this.pending = [];
        this.renderFiles();
        this.renderButton();
    }

    private async addFiles(files: File[]) {
        for (const file of files) {
            if (/\.(md|markdown|txt)$/i.test(file.name) || file.type.startsWith('text/')) {
                this.pending.push({ file, text: await file.text() });
            } else if (file.type.startsWith('image/')) {
                this.pending.push({ file, url: URL.createObjectURL(file) });
            } else toast(`${file.name} is neither a text file nor an image.`, 'error');
        }
        this.renderFiles();
        this.renderButton();
        this.input.focus();
    }

    private renderFiles() {
        clear(this.files);
        this.files.hidden = !this.pending.length;
        for (const p of this.pending) {
            const remove = h('button', { class: 'start-file-remove', title: 'Remove', attrs: { type: 'button', 'aria-label': `Remove ${p.file.name}` } }, icon('close', 11));
            remove.addEventListener('click', () => {
                if (p.url) URL.revokeObjectURL(p.url);
                this.pending = this.pending.filter((x) => x !== p);
                this.renderFiles();
                this.renderButton();
            });
            this.files.appendChild(
                p.url
                    ? h('div', { class: 'start-file image', title: p.file.name }, h('img', { attrs: { src: p.url, alt: p.file.name } }), remove)
                    : h('div', { class: 'start-file doc', title: p.file.name }, icon('open', 13), h('span', { text: p.file.name }), remove),
            );
        }
    }

    private renderButton() {
        this.startBtn.disabled = !this.input.value.trim() && !this.pending.length;
    }

    /** Saves the request as the brief (documents appended, images as reference images) and hands it to the assistant. */
    private async submit() {
        const request = this.input.value.replace(/\r\n?/g, '\n').trim();
        if (!request && !this.pending.length) return;
        const docs = this.pending.filter((p) => p.text !== undefined);
        const metas: AssetMeta[] = [];
        this.startBtn.disabled = true;
        try {
            for (const p of this.pending.filter((x) => x.url)) {
                try {
                    metas.push(await putDesignImage(p.file, p.file.name || 'reference.png'));
                } catch (e: any) {
                    toast(`Could not read ${p.file.name}: ${e?.message || e}`, 'error');
                }
            }
        } finally {
            this.renderButton();
        }
        const text = [request, ...docs.map((p) => `${p.file.name}:\n${p.text!.trim()}`)].filter(Boolean).join('\n\n');
        const doc = this.editor.store.doc;
        const fresh = ['Cube', 'Sphere'].every((name) => doc.nodes.some((n) => n.name === name && n.mesh));
        // The brief and its reference images, one undo step.
        this.editor.store.commit('Start the Scene', (d) => {
            d.design.brief.text = text;
            delete d.design.brief.skipped;
            d.assets.push(...metas);
            for (const m of metas) d.design.concepts.push({ asset: m.id, area: null });
        }, { design: true });
        const images: Attachment[] = metas.map((m) => ({ asset: m.id, name: m.name }));
        const shown = request || (docs.length ? `Build what ${docs.map((p) => p.file.name).join(', ')} describe${docs.length === 1 ? 's' : ''}.` : 'Build what the images show.');
        this.reset();
        this.el.hidden = true;
        this.hooks.start(shown, images, fresh);
    }
}
