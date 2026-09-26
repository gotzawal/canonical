import type { Editor } from '../editor';
import { getAssetUrl, putDesignImage } from '../core/assets';
import { Emitter } from '../core/events';
import { pickFiles } from '../core/persistence';
import type { PaintoverDoc, ParamValue, ShotDoc } from '../core/types';
import { describeSpec, listImageModels, MAX_IMAGES, modelParams, OWN_PARAMS, takesImages, type ImageModel, type ParamSpec } from '../ai/images';
import { aiSettings } from '../ai/settings';
import {
    defaultPaintoverPrompt, generatePaintovers, imageModelId, lastOptions, optionsForShot, paintoverSpend, rememberOptions, uploadPaintover,
    type PaintoverSettings,
} from '../design/paintover';
import { clear, h } from './dom';
import { icon } from './icons';
import { notices } from './notify';
import { lightbox, modal, popover, showMenu, toast, type MenuItem, type Modal } from './overlays';
import { button, iconButton } from './widgets';

/** A generation in progress; it keeps running when the dialog closes. */
interface Job {
    shotId: string;
    count: number;
    abort: AbortController;
    /** Partial images by index while streaming. */
    partials: (string | null)[];
    done: number;
}

const jobs = new Map<string, Job>();
let current: PaintoverDialog | null = null;

/** Tells when a generation starts or ends (the shot id). */
export const paintoverJobs = new Emitter<{ change: string }>();

/** Opens the paintover dialog of a shot. */
export function openPaintoverDialog(editor: Editor, shotId: string) {
    if (current && !current.closed) {
        if (current.shotId === shotId) return;
        current.close();
    }
    if (!editor.pipeline.shot(shotId)) return;
    current = new PaintoverDialog(editor, shotId);
}

/** True while paintovers of the shot are being generated. */
export function generating(shotId: string): boolean {
    return jobs.has(shotId);
}

const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * The paintover dialog of a shot: the references (a fresh greybox capture,
 * the concept, more images), the instruction, the image model and the
 * options it supports, and the shot's paintovers, one of which is chosen as
 * the target. A drawing of one's own can be uploaded instead.
 */
class PaintoverDialog {
    readonly shotId: string;
    private modal: Modal;
    private models: ImageModel[] = [];
    private modelInput: HTMLInputElement;
    private modelInfo: HTMLElement;
    private datalist: HTMLDataListElement;
    private optionsEl: HTMLElement;
    private params: Record<string, ParamValue> = {};
    private prompt: HTMLTextAreaElement;
    private count: HTMLInputElement;
    private countHint: HTMLElement;
    private seed: HTMLInputElement;
    private seedRow: HTMLElement;
    private stream: HTMLInputElement;
    private streamRow: HTMLElement;
    private refsEl: HTMLElement;
    private extra: string[] = [];
    private preview: string | null = null;
    private resultsEl: HTMLElement;
    private status: HTMLElement;
    private genBtn: HTMLButtonElement;
    private cancelBtn: HTMLButtonElement;
    private offs: (() => void)[] = [];
    private key = '';

    constructor(private editor: Editor, shotId: string) {
        this.shotId = shotId;
        const shot = this.shot!;
        const model = imageModelId();
        const last = lastOptions(model);

        this.refsEl = h('div', { class: 'po-refs' });
        this.prompt = h('textarea', { class: 'textarea po-prompt', attrs: { rows: 8, spellcheck: 'true' } });
        this.prompt.value = defaultPaintoverPrompt(editor.store.doc.design, shot);
        this.prompt.addEventListener('keydown', (e) => e.stopPropagation());
        const resetPrompt = h('button', { class: 'link-btn', text: 'Reset to the default', attrs: { type: 'button' } });
        resetPrompt.addEventListener('click', () => (this.prompt.value = defaultPaintoverPrompt(editor.store.doc.design, this.shot!)));

        this.modelInput = h('input', { class: 'text', attrs: { type: 'text', list: 'po-models', spellcheck: 'false', placeholder: 'provider/model' } });
        this.modelInput.value = model;
        this.modelInput.addEventListener('keydown', (e) => e.stopPropagation());
        this.modelInput.addEventListener('change', () => this.modelChanged());
        this.datalist = h('datalist', { attrs: { id: 'po-models' } });
        this.modelInfo = h('div', { class: 'muted small' });
        this.optionsEl = h('div', { class: 'po-options' });

        this.count = h('input', { class: 'text po-num', attrs: { type: 'number', min: 1, max: MAX_IMAGES, step: 1 } });
        this.count.value = String(Math.max(1, Math.min(MAX_IMAGES, last.count)));
        this.count.addEventListener('keydown', (e) => e.stopPropagation());
        this.count.addEventListener('input', () => this.updateButtons());
        this.countHint = h('span', { class: 'muted small' });
        this.seed = h('input', { class: 'text po-num po-seed', attrs: { type: 'number', step: 1, placeholder: 'random' } });
        this.seed.addEventListener('keydown', (e) => e.stopPropagation());
        const dice = iconButton('refresh', 'Random seed', () => (this.seed.value = String(Math.floor(Math.random() * 2 ** 31))));
        this.seedRow = h('label', { class: 'po-field' }, h('span', { text: 'Seed' }), this.seed, dice);
        this.stream = h('input', { attrs: { type: 'checkbox' } });
        this.stream.checked = last.stream;
        this.streamRow = h('label', { class: 'checkbox' }, this.stream, h('span', { text: 'Show partial images while generating' }));

        const form = h(
            'div',
            { class: 'po-form' },
            h('div', { class: 'group-label', text: 'References' }),
            this.refsEl,
            h('div', { class: 'group-label inline' }, h('span', { text: 'Instruction' }), h('div', { class: 'spacer' }), resetPrompt),
            this.prompt,
            h('div', { class: 'group-label', text: 'Image model' }),
            this.modelInput,
            this.datalist,
            this.modelInfo,
            this.optionsEl,
            h('div', { class: 'po-row' }, h('label', { class: 'po-field' }, h('span', { text: 'Images' }), this.count), this.countHint, h('div', { class: 'spacer' }), this.seedRow),
            this.streamRow,
            h('p', { class: 'muted small', text: 'Generations are billed to your OpenRouter account; failed or cancelled ones are not charged.' }),
        );
        this.resultsEl = h('div', { class: 'po-results' });
        const body = h('div', { class: 'po-dialog' }, form, this.resultsEl);

        this.modal = modal(`Paintover: ${shot.name}`, body, { cls: 'po-modal', onClose: () => this.dispose() });
        const upload = button('Upload Your Own...', () => void this.upload(), 'subtle', 'open');
        this.status = h('span', { class: 'muted small po-status' });
        this.cancelBtn = button('Cancel Generation', () => jobs.get(this.shotId)?.abort.abort(), '', 'close');
        this.genBtn = button('Generate', () => void this.generate(), 'primary', 'paint');
        this.modal.footer.append(upload, h('div', { class: 'spacer' }), this.status, this.cancelBtn, this.genBtn);

        this.offs.push(editor.store.on('change', () => this.refresh()));
        this.renderRefs();
        this.refresh(true);
        this.modelChanged(last.params);
        void listImageModels()
            .then((list) => {
                this.models = list.filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('image'));
                this.fillModels();
                this.modelChanged(last.params);
            })
            .catch(() => (this.modelInfo.textContent = 'The image model list is unavailable (offline?). Type a model id.'));
        void this.capturePreview();
    }

    get closed(): boolean {
        return this.modal.closed;
    }

    close() {
        this.modal.close();
    }

    private dispose() {
        for (const off of this.offs) off();
        this.offs = [];
        if (this.preview) URL.revokeObjectURL(this.preview);
        if (current === this) current = null;
    }

    private get shot(): ShotDoc | undefined {
        return this.editor.pipeline.shot(this.shotId);
    }

    private get model(): ImageModel | undefined {
        return this.models.find((m) => m.id === this.modelInput.value.trim());
    }

    // ------------------------------------------------------------ models

    private fillModels() {
        clear(this.datalist);
        const sorted = [...this.models].sort((a, b) => Number(takesImages(b)) - Number(takesImages(a)) || a.id.localeCompare(b.id));
        for (const m of sorted) this.datalist.appendChild(h('option', { attrs: { value: m.id }, text: `${m.name}${takesImages(m) ? '' : ' (no reference images)'}` }));
    }

    /** Rebuilds the options for the chosen model, keeping values it still takes. */
    private modelChanged(start?: Record<string, ParamValue>) {
        const model = this.model;
        const id = this.modelInput.value.trim();
        const shot = this.shot;
        if (!shot) return;
        const params = optionsForShot(model, shot, start ?? { ...lastOptions(id).params, ...this.params });
        this.params = params;
        const specs = modelParams(model);
        clear(this.optionsEl);
        for (const [k, spec] of Object.entries(specs)) {
            if (OWN_PARAMS.has(k)) continue;
            this.optionsEl.appendChild(this.optionField(k, spec));
        }
        if (!model) {
            this.modelInfo.textContent = this.models.length ? `"${id}" is not in the image model list.` : 'Loading the image models...';
        } else {
            const bits = [
                model.name,
                takesImages(model) ? 'takes reference images' : 'takes no reference images, so it cannot paint over the capture',
                model.supports_streaming ? 'streams partial images' : '',
            ].filter(Boolean);
            this.modelInfo.textContent = bits.join(' · ');
            this.modelInfo.classList.toggle('warn', !takesImages(model));
        }
        const n = specs.n;
        this.countHint.textContent = n && n.type === 'range' ? `up to ${Math.min(MAX_IMAGES, n.max)} per request` : 'one request per image';
        this.seedRow.hidden = !!model && !specs.seed;
        this.streamRow.hidden = !model?.supports_streaming;
        this.updateButtons();
    }

    private optionField(key: string, spec: ParamSpec): HTMLElement {
        const label = h('span', { text: humanize(key), title: `${key}: ${describeSpec(spec)}` });
        const set = (v: ParamValue | null) => {
            if (v === null || v === '') delete this.params[key];
            else this.params[key] = v;
        };
        let control: HTMLElement;
        if (spec.type === 'enum' || spec.type === 'boolean') {
            const values = spec.type === 'enum' ? spec.values.map(String) : ['true', 'false'];
            const sel = h('select', { class: 'select' });
            sel.appendChild(h('option', { text: 'Model default', attrs: { value: '' } }));
            for (const v of values) sel.appendChild(h('option', { text: spec.type === 'boolean' ? (v === 'true' ? 'On' : 'Off') : v, attrs: { value: v } }));
            const cur = this.params[key];
            sel.value = cur === undefined ? '' : String(cur);
            if (sel.value !== String(cur ?? '')) sel.value = '';
            sel.addEventListener('change', () => {
                if (!sel.value) return set(null);
                if (spec.type === 'boolean') return set(sel.value === 'true');
                set(spec.values.find((x) => String(x) === sel.value) ?? sel.value);
            });
            sel.addEventListener('keydown', (e) => e.stopPropagation());
            control = sel;
        } else {
            const input = h('input', { class: 'text po-num', attrs: { type: 'number', min: spec.min, max: spec.max, step: Number.isInteger(spec.min) && Number.isInteger(spec.max) ? 1 : 'any', placeholder: `default (${describeSpec(spec)})` } });
            const cur = this.params[key];
            if (typeof cur === 'number') input.value = String(cur);
            input.addEventListener('change', () => set(input.value.trim() === '' ? null : Math.min(spec.max, Math.max(spec.min, Number(input.value)))));
            input.addEventListener('keydown', (e) => e.stopPropagation());
            control = input;
        }
        return h('label', { class: 'po-field' }, label, control);
    }

    // -------------------------------------------------------- references

    /** A fresh render of the shot to show what is sent (stored only when generating). */
    private async capturePreview() {
        try {
            const blob = await this.editor.pipeline.captureShot(this.shotId, 800);
            if (this.closed) return;
            if (this.preview) URL.revokeObjectURL(this.preview);
            this.preview = URL.createObjectURL(blob);
            this.renderRefs();
        } catch {
            /* shown as "captured when generating" */
        }
    }

    private renderRefs() {
        const shot = this.shot;
        if (!shot) return;
        clear(this.refsEl);
        const tile = (img: HTMLElement, caption: string, extra?: Node) => h('figure', { class: 'po-ref' }, img, h('figcaption', null, h('span', { text: caption }), extra ?? null));
        const cap = h('img', { attrs: { alt: '', draggable: 'false' } });
        if (this.preview) {
            cap.src = this.preview;
            cap.addEventListener('click', () => lightbox(this.preview!, 'Greybox capture'));
        } else cap.classList.add('missing');
        this.refsEl.appendChild(tile(cap, this.preview ? 'Greybox capture' : 'Capture (made when generating)', iconButton('refresh', 'Capture again', () => void this.capturePreview())));
        if (shot.concept) this.refsEl.appendChild(tile(this.thumb(shot.concept), 'Concept'));
        for (const id of this.extra) {
            this.refsEl.appendChild(tile(this.thumb(id), this.assetName(id), iconButton('close', 'Remove', () => {
                this.extra = this.extra.filter((x) => x !== id);
                this.renderRefs();
            })));
        }
        const add = h('button', { class: 'po-ref po-add', title: 'Add a reference image', attrs: { type: 'button' } }, icon('plus', 18), h('span', { text: 'Reference' }));
        add.addEventListener('click', () => this.addReference(add));
        this.refsEl.appendChild(add);
    }

    private addReference(anchor: HTMLElement) {
        const doc = this.editor.store.doc;
        const shot = this.shot!;
        const used = new Set([shot.concept, ...this.extra]);
        const items: MenuItem[] = [];
        for (const c of doc.design.concepts) {
            if (used.has(c.asset)) continue;
            items.push({ label: `Concept: ${this.assetName(c.asset)}`, icon: 'image', action: () => this.pushExtra(c.asset) });
        }
        for (const s of doc.design.shots) {
            if (s.id === shot.id || !s.target || used.has(s.target)) continue;
            items.push({ label: `Paintover of ${s.name}`, icon: 'paint', action: () => this.pushExtra(s.target!) });
        }
        const r = anchor.getBoundingClientRect();
        showMenu(
            [
                ...items,
                ...(items.length ? [{ separator: true }] : []),
                {
                    label: 'From File...',
                    icon: 'open',
                    action: async () => {
                        for (const f of await pickFiles('image/*', true)) {
                            const meta = await putDesignImage(f, f.name);
                            this.editor.store.commit('Add Reference Image', (d) => {
                                d.assets.push(meta);
                            }, { design: true });
                            this.pushExtra(meta.id);
                        }
                    },
                },
            ],
            r.left,
            r.bottom + 4,
        );
    }

    private pushExtra(id: string) {
        if (this.extra.length >= 6) return toast('At most six more references.', 'info');
        if (!this.extra.includes(id)) this.extra.push(id);
        this.renderRefs();
    }

    private assetName(id: string): string {
        return this.editor.store.doc.assets.find((a) => a.id === id)?.name ?? id;
    }

    private thumb(id: string | null | undefined, caption = ''): HTMLImageElement {
        const img = h('img', { attrs: { alt: '', draggable: 'false' } });
        const meta = id ? this.editor.store.doc.assets.find((a) => a.id === id) : undefined;
        if (meta) {
            void getAssetUrl(meta).then((url) => {
                if (!url) return img.classList.add('missing');
                img.src = url;
                img.addEventListener('click', () => lightbox(url, caption || meta.name));
            });
        } else img.classList.add('missing');
        return img;
    }

    // ------------------------------------------------------------ results

    private refresh(force = false) {
        const shot = this.shot;
        if (!shot) {
            this.close();
            return;
        }
        const job = jobs.get(this.shotId);
        const key = JSON.stringify([shot.paintovers.map((p) => p.asset), shot.target, shot.stale, job ? [job.done, job.partials.map((p) => (p ? p.length : 0))] : null]);
        if (!force && key === this.key) return;
        this.key = key;
        clear(this.resultsEl);
        const d = this.editor.store.doc.design;
        const head = h('div', { class: 'po-results-head' }, h('div', { class: 'group-label', text: `Paintovers (${shot.paintovers.length})` }));
        this.resultsEl.appendChild(head);
        const notes: string[] = [];
        const open = this.editor.pipeline.progress('level').items.filter((i) => ['level.route', 'level.sightlines', 'level.play'].includes(i.id) && !i.done);
        if (open.length && d.stage === 'level') notes.push('Play checks are still open. Paintovers are best made once the blockout passes them.');
        if (shot.stale) notes.push('The level changed after the target was chosen. Make a new paintover or choose the target again.');
        if (!shot.target && shot.paintovers.length) notes.push('Choose the paintover that becomes the target of this shot.');
        for (const n of notes) this.resultsEl.appendChild(h('div', { class: 'design-note' }, icon('info', 14), h('span', { text: n })));
        const grid = h('div', { class: 'po-grid' });
        if (job) {
            for (let i = 0; i < job.count; i++) {
                const partial = job.partials[i];
                const tile = h('div', { class: 'po-tile running' });
                if (partial) tile.appendChild(h('img', { attrs: { src: partial, alt: '' } }));
                tile.appendChild(h('div', { class: 'po-spinner' }, icon('sparkle', 16), h('span', { text: i < job.done ? 'Done' : partial ? 'Painting...' : 'Waiting...' })));
                grid.appendChild(tile);
            }
        }
        for (const p of [...shot.paintovers].reverse()) grid.appendChild(this.tile(shot, p));
        if (!shot.paintovers.length && !job) grid.appendChild(h('div', { class: 'muted small pad', text: 'No paintovers yet. Generate some from the capture and the concept, or upload your own.' }));
        this.resultsEl.appendChild(grid);
        const spent = paintoverSpend(d);
        this.status.textContent = job ? `Generating ${job.done}/${job.count}...` : spent > 0 ? `Spent on paintovers: $${spent.toFixed(3)}` : '';
        this.updateButtons();
    }

    private tile(shot: ShotDoc, p: PaintoverDoc): HTMLElement {
        const pipeline = this.editor.pipeline;
        const isTarget = shot.target === p.asset;
        const meta = this.editor.store.doc.assets.find((a) => a.id === p.asset);
        const label = p.source === 'upload' ? 'Uploaded' : `${(p.model ?? 'generated').split('/').pop()}${p.seed != null ? ` · ${p.seed}` : ''}`;
        const choose = isTarget
            ? h('span', { class: 'shot-badge ok', text: shot.stale ? 'target (needs update)' : 'target' })
            : button('Use as Target', () => pipeline.choosePaintover(shot.id, p.asset), 'small primary', 'check');
        const info = iconButton('info', 'Details', (e) => this.details(e.currentTarget as HTMLElement, p));
        const reuse = p.source === 'generated' ? iconButton('undo', 'Use these settings again', () => this.reuse(p)) : null;
        const remove = iconButton('trash', 'Delete', () => pipeline.deletePaintover(shot.id, p.asset));
        const warn = meta?.width && meta.height && Math.abs(Math.log(meta.width / meta.height / shot.aspect)) > 0.03
            ? h('div', { class: 'po-warn', text: `Aspect ${(meta.width / meta.height).toFixed(2)} differs from the shot's ${shot.aspect.toFixed(2)}` })
            : null;
        return h(
            'div',
            { class: 'po-tile' + (isTarget ? ' target' : '') },
            this.thumb(p.asset, `${shot.name}: ${label}`),
            h('div', { class: 'po-tile-bar' }, h('span', { class: 'po-label', text: label, title: p.prompt ?? '' }), h('div', { class: 'spacer' }), info, reuse, remove),
            h('div', { class: 'po-tile-actions' }, choose),
            warn,
        );
    }

    private details(anchor: HTMLElement, p: PaintoverDoc) {
        const lines: [string, string][] = [
            ['Source', p.source === 'upload' ? 'Uploaded' : 'Generated'],
            ['Made', p.at.slice(0, 16).replace('T', ' ')],
        ];
        if (p.model) lines.push(['Model', p.model]);
        if (p.seed != null) lines.push(['Seed', String(p.seed)]);
        if (p.params && Object.keys(p.params).length) lines.push(['Options', Object.entries(p.params).map(([k, v]) => `${k}: ${v}`).join(', ')]);
        if (p.cost != null) lines.push(['Cost', `$${p.cost.toFixed(4)}`]);
        if (p.refs?.length) lines.push(['References', p.refs.map((r) => this.assetName(r)).join(', ')]);
        const table = h('div', { class: 'po-details' }, lines.map(([k, v]) => h('div', { class: 'po-detail' }, h('span', { class: 'muted', text: k }), h('span', { text: v }))));
        if (p.prompt) table.appendChild(h('pre', { class: 'po-detail-prompt', text: p.prompt }));
        popover(anchor, table, 'wide');
    }

    private reuse(p: PaintoverDoc) {
        if (p.prompt) this.prompt.value = p.prompt;
        if (p.model) this.modelInput.value = p.model;
        this.seed.value = p.seed != null ? String(p.seed) : '';
        this.extra = (p.refs ?? []).filter((r) => r !== this.shot?.concept && this.editor.store.doc.design.shots.every((s) => !s.history.some((hh) => hh.asset === r)));
        this.params = { ...(p.params ?? {}) };
        this.modelChanged(this.params);
        this.renderRefs();
        toast('Settings of that paintover are back in the form.', 'info');
    }

    private updateButtons() {
        const running = jobs.has(this.shotId);
        this.cancelBtn.hidden = !running;
        this.genBtn.disabled = running;
        const n = Math.max(1, Math.min(MAX_IMAGES, Math.round(Number(this.count.value) || 1)));
        (this.genBtn.querySelector('span') as HTMLElement).textContent = running ? 'Generating...' : `Generate ${n}`;
    }

    // ----------------------------------------------------------- actions

    private settings(): PaintoverSettings | null {
        const model = this.modelInput.value.trim();
        if (!model) {
            toast('Pick an image model.', 'info');
            return null;
        }
        const prompt = this.prompt.value.trim();
        if (!prompt) {
            toast('Write the instruction first.', 'info');
            return null;
        }
        const seedText = this.seed.value.trim();
        return {
            model,
            prompt,
            count: Math.max(1, Math.min(MAX_IMAGES, Math.round(Number(this.count.value) || 1))),
            seed: seedText && !this.seedRow.hidden ? Math.round(Number(seedText)) : null,
            params: { ...this.params },
            stream: !this.streamRow.hidden && this.stream.checked,
            extra: [...this.extra],
        };
    }

    private async generate() {
        if (jobs.has(this.shotId)) return;
        if (!aiSettings.apiKey) {
            toast('Add an OpenRouter key in the AI settings first.', 'error');
            return;
        }
        const settings = this.settings();
        if (!settings) return;
        rememberOptions(settings.model, settings.count, settings.stream, settings.params);
        await runJob(this.editor, this.shotId, settings);
    }

    private async upload() {
        const files = await pickFiles('image/*', false);
        const f = files[0];
        if (!f) return;
        try {
            await uploadPaintover(this.editor, this.shotId, f);
            toast(`Added ${f.name}.`, 'success');
        } catch (e: any) {
            toast(`Upload failed: ${e?.message || e}`, 'error');
        }
    }

    /** Redraws when a job changes. */
    jobChanged() {
        this.refresh();
    }
}

/** Runs a generation for a shot; it goes on when the dialog closes and reports when done. */
async function runJob(editor: Editor, shotId: string, settings: PaintoverSettings) {
    const job: Job = { shotId, count: settings.count, abort: new AbortController(), partials: new Array(settings.count).fill(null), done: 0 };
    jobs.set(shotId, job);
    paintoverJobs.emit('change', shotId);
    const changed = () => {
        if (current && current.shotId === shotId && !current.closed) current.jobChanged();
    };
    changed();
    const shotName = () => editor.pipeline.shot(shotId)?.name ?? 'the shot';
    try {
        const res = await generatePaintovers(editor, shotId, settings, {
            signal: job.abort.signal,
            onPartial: (i, url) => {
                if (i < job.partials.length) job.partials[i] = url;
                changed();
            },
            onProgress: (done) => {
                job.done = done;
                changed();
            },
        });
        const n = res.paintovers.length;
        const cost = res.cost != null ? ` ($${res.cost.toFixed(3)})` : '';
        toast(`${n} paintover${n === 1 ? '' : 's'} for ${shotName()}${cost}.`, 'success');
        if (res.errors.length) toast(`${res.errors.length} request${res.errors.length === 1 ? '' : 's'} failed: ${res.errors[0]}`, 'error');
        if (res.dropped.length) toast(`Left out options the model does not take: ${res.dropped.join(', ')}`, 'info', 6000);
        const away = document.hidden || !document.hasFocus() || !current || current.closed || current.shotId !== shotId;
        if (away) {
            notices.show({
                kind: 'ai-done',
                key: `paintover-${shotId}`,
                icon: 'paint',
                title: 'Paintovers are ready',
                body: `${n} for ${shotName()}. Choose the target.`,
                actions: [{ label: 'Open', primary: true, run: () => openPaintoverDialog(editor, shotId) }],
            });
        }
    } catch (e: any) {
        if (e?.name === 'AbortError') toast('Generation cancelled (not charged).', 'info');
        else toast(`Generation failed: ${e?.message || e}`, 'error');
    } finally {
        jobs.delete(shotId);
        paintoverJobs.emit('change', shotId);
        changed();
    }
}
