import type { Editor } from '../editor';
import { getAssetUrl } from '../core/assets';
import { pickFiles } from '../core/persistence';
import type { MaterialSlotDoc, ParamValue } from '../core/types';
import { listImageModels, MAX_IMAGES, modelParams, OWN_PARAMS, takesImages, type ImageModel } from '../ai/images';
import { aiSettings } from '../ai/settings';
import { roomSample, useSwatch } from '../design/materialSlots';
import { imageModelId } from '../design/paintover';
import {
    deleteSwatch, generateSwatches, importSwatches, searchSwatches, swatchPrompt, tagsFrom, updateSwatch, type SwatchRecord,
} from '../design/swatches';
import { clear, h } from './dom';
import { icon } from './icons';
import { optionField } from './imageOptions';
import { notices } from './notify';
import { lightbox, modal, popover, toast, type Modal } from './overlays';
import { button, iconButton } from './widgets';
import type { RoomSample } from '../viewport/referenceRoom';

let current: SwatchDialog | null = null;

/** Opens the swatch library, for a material slot (to use a swatch on it) or on its own. */
export function openSwatchDialog(editor: Editor, slotId: string | null) {
    current?.close();
    current = new SwatchDialog(editor, slotId);
}

/**
 * The swatch library and swatch generation. The library is searched first
 * (by the slot's name and description); a new swatch is generated from the
 * slot's description with the concepts and paintovers as references only
 * when nothing fits. Every swatch is processed into a flat, tileable albedo
 * and kept in the library of this browser for every project.
 */
class SwatchDialog {
    private modal: Modal;
    private search: HTMLInputElement;
    private grid: HTMLElement;
    private refsEl: HTMLElement;
    private refs = new Set<string>();
    private prompt: HTMLTextAreaElement;
    private nameInput: HTMLInputElement;
    private tagsInput: HTMLInputElement;
    private tileInput: HTMLInputElement;
    private modelInput: HTMLInputElement;
    private optionsEl: HTMLElement;
    private count: HTMLInputElement;
    private params: Record<string, ParamValue> = {};
    private models: ImageModel[] = [];
    private status: HTMLElement;
    private genBtn: HTMLButtonElement;
    private cancelBtn: HTMLButtonElement;
    private abort: AbortController | null = null;
    private urls: string[] = [];
    private searchTimer = 0;
    private fresh = new Set<string>();

    constructor(private editor: Editor, private slotId: string | null) {
        const slot = this.slot;
        const title = slot ? `Swatch: ${slot.name}` : 'Swatch Library';
        this.search = h('input', { class: 'text sw-search', attrs: { type: 'search', placeholder: 'Search names and tags...', spellcheck: 'false' } });
        this.search.value = slot ? tagsFrom(`${slot.name} ${slot.description}`).slice(0, 4).join(' ') : '';
        this.search.addEventListener('keydown', (e) => e.stopPropagation());
        this.search.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => void this.renderLibrary(), 200);
        });
        this.grid = h('div', { class: 'sw-grid' });

        this.nameInput = this.text(slot?.name ?? 'Swatch');
        this.tagsInput = this.text(slot ? tagsFrom(`${slot.name} ${slot.description}`).join(', ') : '', 'tags, comma separated');
        this.tileInput = h('input', { class: 'text po-num', attrs: { type: 'number', min: 0.05, max: 100, step: 0.05 } });
        this.tileInput.value = String(slot?.tile ?? 2);
        this.tileInput.addEventListener('keydown', (e) => e.stopPropagation());
        this.refsEl = h('div', { class: 'po-refs' });
        this.prompt = h('textarea', { class: 'textarea po-prompt', attrs: { rows: 6, spellcheck: 'true' } });
        this.prompt.addEventListener('keydown', (e) => e.stopPropagation());
        const reset = h('button', { class: 'link-btn', text: 'Reset to the default', attrs: { type: 'button' } });
        reset.addEventListener('click', () => (this.prompt.value = this.defaultPrompt()));
        this.modelInput = h('input', { class: 'text', attrs: { type: 'text', list: 'sw-models', spellcheck: 'false' } });
        this.modelInput.value = imageModelId();
        this.modelInput.addEventListener('keydown', (e) => e.stopPropagation());
        this.modelInput.addEventListener('change', () => this.renderOptions());
        const datalist = h('datalist', { attrs: { id: 'sw-models' } });
        this.optionsEl = h('div', { class: 'po-options' });
        this.count = h('input', { class: 'text po-num', attrs: { type: 'number', min: 1, max: MAX_IMAGES, step: 1 } });
        this.count.value = '2';
        this.count.addEventListener('keydown', (e) => e.stopPropagation());
        this.count.addEventListener('input', () => this.updateButtons());

        // Concepts and paintovers to match: the shots' targets first.
        const d = editor.store.doc.design;
        const targets = d.shots.map((s) => s.target).filter((x): x is string => !!x);
        for (const id of (targets.length ? targets : d.concepts.map((c) => c.asset)).slice(0, 2)) this.refs.add(id);
        this.prompt.value = this.defaultPrompt();

        const form = h(
            'div',
            { class: 'po-form' },
            h('div', { class: 'group-label', text: 'Generate a swatch' }),
            h('p', { class: 'muted small', text: 'Search the library first; generate only when nothing fits. Results are cropped square, evened out, made tileable and kept within sRGB 30-240, then saved to the library.' }),
            h('div', { class: 'po-options' }, field('Name', this.nameInput), field('Tile (m)', this.tileInput)),
            field('Tags', this.tagsInput),
            h('div', { class: 'group-label', text: 'Match these (concepts, paintovers)' }),
            this.refsEl,
            h('div', { class: 'group-label inline' }, h('span', { text: 'Instruction' }), h('div', { class: 'spacer' }), reset),
            this.prompt,
            h('div', { class: 'group-label', text: 'Image model' }),
            this.modelInput,
            datalist,
            this.optionsEl,
            h('div', { class: 'po-row' }, field('Images', this.count)),
            h('p', { class: 'muted small', text: 'Billed to your OpenRouter account; failed or cancelled generations are not charged.' }),
        );
        const library = h(
            'div',
            { class: 'po-results' },
            h('div', { class: 'sw-libhead' }, h('div', { class: 'group-label', text: 'Library (this browser, every project)' }), h('div', { class: 'spacer' }), this.search),
            this.grid,
        );
        this.modal = modal(title, h('div', { class: 'po-dialog sw-dialog' }, form, library), { cls: 'po-modal', onClose: () => this.dispose() });
        const importBtn = button('Import Images...', () => void this.importFiles(), 'subtle', 'open');
        this.status = h('span', { class: 'muted small po-status' });
        this.cancelBtn = button('Cancel', () => this.abort?.abort(), '', 'close');
        this.genBtn = button('Generate', () => void this.generate(), 'primary', 'wand');
        this.modal.footer.append(importBtn, h('div', { class: 'spacer' }), this.status, this.cancelBtn, this.genBtn);

        this.renderRefs();
        this.renderOptions();
        this.updateButtons();
        void this.renderLibrary();
        void listImageModels()
            .then((list) => {
                this.models = list.filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('image'));
                for (const m of this.models) datalist.appendChild(h('option', { attrs: { value: m.id }, text: m.name }));
                this.renderOptions();
            })
            .catch(() => {});
    }

    private get slot(): MaterialSlotDoc | undefined {
        return this.slotId ? this.editor.store.doc.design.materials.find((s) => s.id === this.slotId) : undefined;
    }

    close() {
        this.modal.close();
    }

    private dispose() {
        this.abort?.abort();
        for (const u of this.urls) URL.revokeObjectURL(u);
        this.urls = [];
        if (current === this) current = null;
    }

    private text(value: string, placeholder = ''): HTMLInputElement {
        const el = h('input', { class: 'text', attrs: { type: 'text', placeholder, spellcheck: 'false' } });
        el.value = value;
        el.addEventListener('keydown', (e) => e.stopPropagation());
        return el;
    }

    private defaultPrompt(): string {
        const slot = this.slot;
        return swatchPrompt({ name: this.nameInput.value.trim() || slot?.name || 'material', description: slot?.description ?? '', tile: Number(this.tileInput.value) || slot?.tile || 2 }, this.refs.size > 0);
    }

    private renderRefs() {
        clear(this.refsEl);
        const d = this.editor.store.doc.design;
        const candidates: { id: string; label: string }[] = [];
        for (const s of d.shots) if (s.target) candidates.push({ id: s.target, label: `Paintover: ${s.name}` });
        for (const c of d.concepts) candidates.push({ id: c.asset, label: 'Concept' });
        if (!candidates.length) {
            this.refsEl.appendChild(h('span', { class: 'muted small', text: 'No concepts or paintovers in this project.' }));
            return;
        }
        for (const c of candidates.slice(0, 12)) {
            const on = this.refs.has(c.id);
            const img = h('img', { attrs: { alt: '', draggable: 'false' } });
            const meta = this.editor.store.doc.assets.find((a) => a.id === c.id);
            if (meta) void getAssetUrl(meta).then((u) => u && (img.src = u));
            const tile = h('button', { class: 'po-ref sw-ref' + (on ? ' on' : ''), title: `${c.label} (click to ${on ? 'leave out' : 'use'})`, attrs: { type: 'button' } }, img, h('span', { class: 'small', text: c.label }));
            tile.addEventListener('click', () => {
                if (this.refs.has(c.id)) this.refs.delete(c.id);
                else this.refs.add(c.id);
                this.renderRefs();
            });
            this.refsEl.appendChild(tile);
        }
    }

    private renderOptions() {
        const model = this.models.find((m) => m.id === this.modelInput.value.trim());
        clear(this.optionsEl);
        const specs = modelParams(model);
        for (const k of Object.keys(this.params)) if (model && !specs[k]) delete this.params[k];
        for (const [k, spec] of Object.entries(specs)) {
            if (OWN_PARAMS.has(k) || k === 'aspect_ratio' || k === 'size') continue;
            this.optionsEl.appendChild(optionField(k, spec, this.params));
        }
        if (model && !takesImages(model) && this.refs.size) {
            this.optionsEl.appendChild(h('div', { class: 'po-warn', text: `${model.name} takes no reference images; it works from the instruction only.` }));
        }
    }

    private updateButtons() {
        const running = !!this.abort;
        this.cancelBtn.hidden = !running;
        this.genBtn.disabled = running;
        const n = Math.max(1, Math.min(MAX_IMAGES, Math.round(Number(this.count.value) || 1)));
        (this.genBtn.querySelector('span') as HTMLElement).textContent = running ? 'Generating...' : `Generate ${n}`;
    }

    // ------------------------------------------------------------- library

    private async renderLibrary() {
        const found = await searchSwatches(this.search.value, 60);
        if (this.modal.closed) return;
        for (const u of this.urls) URL.revokeObjectURL(u);
        this.urls = [];
        clear(this.grid);
        if (!found.length) {
            this.grid.appendChild(h('div', { class: 'muted small pad', text: this.search.value.trim() ? 'Nothing in the library matches. Generate one, or import images.' : 'The library is empty. Generate swatches or import images.' }));
            return;
        }
        for (const { swatch } of found) this.grid.appendChild(this.tile(swatch));
    }

    private tile(s: SwatchRecord): HTMLElement {
        const url = URL.createObjectURL(s.blob);
        this.urls.push(url);
        const img = h('img', { attrs: { src: url, alt: s.name, draggable: 'false' } });
        img.addEventListener('click', () => lightbox(url, `${s.name} (${s.tile} m per tile)`));
        const slot = this.slot;
        const inUse = !!slot?.swatch && this.editor.store.doc.assets.find((a) => a.id === slot.swatch)?.name.includes(`.${s.id}.`);
        const use = slot
            ? inUse
                ? h('span', { class: 'shot-badge ok', text: 'in use' })
                : button('Use', () => void this.use(s), 'small primary', 'check')
            : null;
        const preview = iconButton('sun', 'Look at it in the reference room', () => this.preview(s));
        const info = iconButton('info', 'Details and tags', (e) => this.details(e.currentTarget as HTMLElement, s));
        const remove = iconButton('trash', 'Delete from the library', async () => {
            await deleteSwatch(s.id);
            void this.renderLibrary();
        });
        return h(
            'div',
            { class: 'po-tile sw-tile' + (this.fresh.has(s.id) ? ' fresh' : '') + (inUse ? ' target' : '') },
            img,
            h('div', { class: 'po-tile-bar' }, h('span', { class: 'po-label', text: s.name, title: s.tags.join(', ') }), h('div', { class: 'spacer' }), preview, info, remove),
            h('div', { class: 'po-tile-actions' }, use, h('span', { class: 'muted small', text: `${s.tile} m${s.source === 'generated' ? ' · generated' : ''}` })),
        );
    }

    private details(anchor: HTMLElement, s: SwatchRecord) {
        const name = this.text(s.name);
        const tags = this.text(s.tags.join(', '));
        const tile = h('input', { class: 'text po-num', attrs: { type: 'number', min: 0.05, max: 100, step: 0.05 } });
        tile.value = String(s.tile);
        tile.addEventListener('keydown', (e) => e.stopPropagation());
        const save = button('Save', async () => {
            await updateSwatch(s.id, { name: name.value.trim() || s.name, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), tile: Math.max(0.05, Number(tile.value) || s.tile) });
            close();
            void this.renderLibrary();
        }, 'small primary', 'check');
        const lines: [string, string][] = [['Made', s.created.slice(0, 16).replace('T', ' ')], ['Size', `${s.size} px`], ['Mean color', s.color]];
        if (s.model) lines.push(['Model', s.model]);
        if (s.seed != null) lines.push(['Seed', String(s.seed)]);
        if (s.cost != null) lines.push(['Cost', `$${s.cost.toFixed(4)}`]);
        const box = h(
            'div',
            { class: 'po-details' },
            field('Name', name),
            field('Tags', tags),
            field('Tile (m)', tile),
            lines.map(([k, v]) => h('div', { class: 'po-detail' }, h('span', { class: 'muted', text: k }), h('span', { text: v }))),
            s.prompt ? h('pre', { class: 'po-detail-prompt', text: s.prompt }) : null,
            h('div', { class: 'inline' }, save),
        );
        const close = popover(anchor, box, 'wide');
    }

    private async use(s: SwatchRecord) {
        if (!this.slotId) return;
        try {
            const slot = await useSwatch(this.editor, this.slotId, s.id);
            toast(`${slot.name} uses ${s.name} now.`, 'success');
            void this.renderLibrary();
        } catch (e: any) {
            toast(e?.message || String(e), 'error');
        }
    }

    private preview(s: SwatchRecord) {
        const doc = this.editor.store.doc;
        const slot = this.slot;
        const samples: RoomSample[] = [{ name: s.name, texture: s.blob, color: '#ffffff', roughness: s.roughness ?? slot?.roughness ?? 0.8, metallic: s.metallic ?? slot?.metallic ?? 0, tile: s.tile }];
        if (slot) samples.push({ ...roomSample(doc, slot), name: `${slot.name} (now)` });
        this.close();
        void this.editor.room?.open(samples);
    }

    // ------------------------------------------------------------- actions

    private async importFiles() {
        const files = await pickFiles('image/*', true);
        if (!files.length) return;
        this.status.textContent = 'Processing...';
        try {
            const tags = this.tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
            const recs = await importSwatches(files, { tags, tile: Number(this.tileInput.value) || 2 });
            for (const r of recs) this.fresh.add(r.id);
            toast(`Added ${recs.length} swatch${recs.length === 1 ? '' : 'es'} to the library.`, 'success');
            this.search.value = '';
            await this.renderLibrary();
        } catch (e: any) {
            toast(`Import failed: ${e?.message || e}`, 'error');
        } finally {
            this.status.textContent = '';
        }
    }

    private async generate() {
        if (this.abort) return;
        if (!aiSettings.apiKey) return toast('Add an OpenRouter key in the AI settings first.', 'error');
        const model = this.modelInput.value.trim();
        const prompt = this.prompt.value.trim();
        if (!model || !prompt) return toast('Pick a model and write the instruction.', 'info');
        const slot = this.slot;
        this.abort = new AbortController();
        this.updateButtons();
        const count = Math.max(1, Math.min(MAX_IMAGES, Math.round(Number(this.count.value) || 1)));
        this.status.textContent = `Generating 0/${count}...`;
        try {
            const res = await generateSwatches(
                {
                    prompt,
                    refs: [...this.refs],
                    count,
                    model,
                    params: { ...this.params },
                    seed: null,
                    name: this.nameInput.value.trim() || 'Swatch',
                    tags: this.tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
                    tile: Math.max(0.05, Number(this.tileInput.value) || 2),
                    ...(slot ? { roughness: slot.roughness, metallic: slot.metallic } : {}),
                },
                { signal: this.abort.signal, onProgress: (done, total) => (this.status.textContent = `Generating ${done}/${total}...`) },
            );
            for (const r of res.swatches) this.fresh.add(r.id);
            const cost = res.cost != null ? ` ($${res.cost.toFixed(3)})` : '';
            toast(`${res.swatches.length} swatch${res.swatches.length === 1 ? '' : 'es'} added to the library${cost}.`, 'success');
            if (res.errors.length) toast(`${res.errors.length} request${res.errors.length === 1 ? '' : 's'} failed: ${res.errors[0]}`, 'error');
            if (document.hidden || !document.hasFocus()) {
                notices.show({ kind: 'ai-done', key: 'swatches', icon: 'wand', title: 'Swatches are ready', body: `${res.swatches.length} new in the library.`, actions: this.slotId ? [{ label: 'Open', primary: true, run: () => openSwatchDialog(this.editor, this.slotId) }] : [] });
            }
            if (!this.modal.closed) {
                this.search.value = '';
                await this.renderLibrary();
            }
        } catch (e: any) {
            if (e?.name === 'AbortError') toast('Generation cancelled (not charged).', 'info');
            else toast(`Generation failed: ${e?.message || e}`, 'error');
        } finally {
            this.abort = null;
            this.status.textContent = '';
            if (!this.modal.closed) this.updateButtons();
        }
    }
}

function field(label: string, control: HTMLElement): HTMLElement {
    return h('label', { class: 'po-field' }, h('span', { text: label }), control);
}
