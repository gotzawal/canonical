import type { Editor } from '../editor';
import { getAssetUrl, putDesignImage } from '../core/assets';
import { areaName, STAGE_IDS, stageIndex } from '../core/design';
import { uid } from '../core/ids';
import { download, pickFiles } from '../core/persistence';
import type { AreaDoc, AssetMeta, DesignDoc, MaterialSlotDoc, ShotDoc, StageId, Vec3 } from '../core/types';
import { STAGE_PROMPTS, structurePrompt } from '../design/prompts';
import { stageDef } from '../design/stages';
import { checklistView } from './checklist';
import { generating, openPaintoverDialog, paintoverJobs } from './paintoverDialog';
import { openSwatchDialog } from './swatchDialog';
import { assignSlot, deleteSlot, roomSample, slotUsers, upsertSlot, type SlotPatch } from '../design/materialSlots';
import { clear, h } from './dom';
import { icon } from './icons';
import { confirmDialog, popover, showMenu, toast } from './overlays';
import {
    CheckboxField, ColorField, NumberField, SelectField, SliderField, TextAreaField, TextField, Vec3Field, button, iconButton, row, section,
} from './widgets';

export interface DesignPanelHooks {
    /** Opens the brief screen. */
    showBrief(): void;
    /** Sends a request to the assistant (and shows the AI tab). */
    ask(text: string, images?: { asset: string; name: string }[]): void;
}

/**
 * The Design tab: the current stage with its checklist, the brief and its
 * concept images, the structured plan, the shots, snapshots and the scene
 * memo.
 */
export class DesignPanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private key = '';
    private pending = false;
    private openAreas = new Set<string>();
    private openSlots = new Set<string>();

    constructor(private editor: Editor, private hooks: DesignPanelHooks) {
        this.body = h('div', { class: 'panel-body design-body' });
        this.el = h('div', { class: 'panel design-panel' }, this.body);
        const store = editor.store;
        store.on('change', () => this.schedule());
        store.on('load', () => this.schedule(true));
        editor.pipeline.on('busy', () => this.schedule(true));
        editor.pipeline.on('shot', () => this.schedule(true));
        paintoverJobs.on('change', () => this.schedule(true));
        store.on('selection', () => {
            if (this.openSlots.size) this.schedule();
        });
        // Values typed into a field are committed on blur; render after that.
        this.body.addEventListener('focusout', () => {
            if (this.pending) this.schedule();
        });
    }

    private get store() {
        return this.editor.store;
    }

    private get design(): DesignDoc {
        return this.store.doc.design;
    }

    /** Commits a change to the design section as one undo step. */
    private edit(label: string, fn: (d: DesignDoc) => void) {
        this.store.commit(label, (doc) => fn(doc.design), { design: true });
    }

    private schedule(force = false) {
        if (force) this.key = '';
        if (this.el.hidden) {
            this.pending = true;
            return;
        }
        const active = document.activeElement;
        if (active && this.body.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            this.pending = true;
            return;
        }
        this.pending = false;
        const d = this.design;
        const prog = this.editor.pipeline.progress();
        // Slot users and, while a slot is open, the selection (for "Assign to selection").
        const slotUse = this.store.doc.nodes.filter((n) => n.mesh?.material.slot).map((n) => n.mesh!.material.slot).join();
        const sel = this.openSlots.size ? this.store.selection.join() : '';
        const key = JSON.stringify([{ ...d, brief: { ...d.brief, text: d.brief.text.length } }, prog.items.map((i) => i.done + (i.detail ?? '')), this.store.doc.assets.length, this.editor.pipeline.activeShot, this.editor.pipeline.busy, slotUse, sel]);
        if (key === this.key) return;
        this.key = key;
        this.render();
    }

    /** Called when the tab becomes visible. */
    shown() {
        this.schedule(this.pending);
    }

    private render() {
        const scroll = this.body.scrollTop;
        clear(this.body);
        this.body.append(this.stageSection(), this.briefSection(), this.planSection(), this.shotsSection(), this.materialsSection(), this.snapshotSection(), this.memoSection());
        this.body.scrollTop = scroll;
    }

    // --------------------------------------------------------------- stage

    private stageSection(): HTMLElement {
        const pipeline = this.editor.pipeline;
        const d = this.design;
        const id = d.stage;
        const def = stageDef(id);
        const st = d.stages[id];
        const rows: Node[] = [];
        rows.push(
            h(
                'div',
                { class: 'stage-head' },
                h('span', { class: 'stage-count', text: `Stage ${stageIndex(id) + 1} of ${STAGE_IDS.length}` }),
                h('span', { class: 'stage-status ' + st.status, text: st.status === 'done' ? 'complete' : st.status }),
            ),
            h('div', { class: 'stage-title', text: def.long }),
            h('p', { class: 'stage-desc', text: def.description }),
        );
        const rechecks = STAGE_IDS.filter((s) => d.stages[s].recheck && d.stages[s].status === 'recheck');
        for (const s of rechecks) rows.push(h('div', { class: 'design-note warn' }, icon('alert', 14), h('span', { text: `${stageDef(s).title} needs a recheck: ${d.stages[s].recheck}` })));
        const rework = d.areas.filter((a) => a.rework);
        for (const a of rework) {
            rows.push(
                h(
                    'div',
                    { class: 'design-note warn' },
                    icon('alert', 14),
                    h('span', { text: `${a.name} changed in the brief: redo it from ${stageDef(a.rework!).title}.${a.reworkNote ? ' ' + a.reworkNote : ''}` }),
                    button('Done', () => this.edit('Area Reworked', (dd) => {
                        const area = dd.areas.find((x) => x.id === a.id);
                        if (area) {
                            delete area.rework;
                            delete area.reworkNote;
                        }
                    }), 'small'),
                ),
            );
        }
        if (st.proposal) {
            rows.push(
                h(
                    'div',
                    { class: 'design-proposal' },
                    h('div', { class: 'design-proposal-title' }, icon('flag', 14), h('span', { text: 'The assistant proposes completing this stage' })),
                    h('div', { class: 'design-proposal-text', text: st.proposal.summary }),
                    h(
                        'div',
                        { class: 'inline' },
                        button(`Complete ${def.title}`, () => void pipeline.complete(), 'small primary', 'flag'),
                        button('Not yet', () => pipeline.dismissProposal(), 'small subtle'),
                    ),
                ),
            );
        }
        rows.push(checklistView(this.editor, id, { add: true }));
        const actions = h('div', { class: 'design-actions' });
        if (st.status !== 'done') {
            const open = this.editor.pipeline.progress(id).open.length;
            actions.append(
                button(pipeline.busy ? 'Capturing shots...' : open ? `Complete ${def.title} (${open} open)` : `Complete ${def.title}`, () => void pipeline.complete(), open ? 'small' : 'small primary', 'flag'),
                button(id === 'brief' ? 'Structure with AI' : 'Ask AI to work on it', () => this.askStage(id), 'small', 'sparkle'),
            );
        } else actions.append(h('span', { class: 'muted small', text: 'Every stage is complete. Reopen a stage from the pipeline bar to change it.' }));
        if (id === 'brief') actions.append(button('Open brief', () => this.hooks.showBrief(), 'small', 'open'));
        rows.push(actions);
        if ((id === 'light' || id === 'material' || id === 'finish') && st.status !== 'done') {
            rows.push(
                h(
                    'div',
                    { class: 'design-actions' },
                    button('Key light from the mood', () => {
                        pipeline.applyKeyLight();
                        toast('The key light and the sky\'s sun follow the mood now.', 'success');
                    }, 'small', 'sun'),
                    button('Sky, exposure and GI', () => this.editor.emit('show-scene', undefined), 'small', 'sliders'),
                    d.shots.some((s) => s.target) ? button('Compare shots', () => pipeline.openCompare((d.shots.find((s) => s.target && !s.matched?.includes(id)) ?? d.shots.find((s) => s.target))!.id), 'small', 'graph') : null,
                ),
            );
        }
        return section('design-stage', 'Stage', 'flag', rows);
    }

    private askStage(id: StageId) {
        if (id === 'brief') {
            this.structure();
            return;
        }
        this.hooks.ask(STAGE_PROMPTS[id]);
    }

    /** Asks the assistant to structure (or restructure) the brief, with the concept images attached. */
    structure() {
        const d = this.design;
        if (!d.brief.text.trim() && !d.concepts.length) {
            this.hooks.showBrief();
            return;
        }
        const restructure = !!d.brief.structuredAt && d.brief.structured !== d.brief.text;
        const images = restructure ? [] : d.concepts.slice(0, 8).map((c) => ({ asset: c.asset, name: this.assetName(c.asset) }));
        this.hooks.ask(structurePrompt(restructure), images);
    }

    // --------------------------------------------------------------- brief

    private assetName(id: string): string {
        return this.store.doc.assets.find((a) => a.id === id)?.name ?? id;
    }

    private thumb(assetId: string | null | undefined, cls = 'design-thumb'): HTMLElement {
        const img = h('img', { class: cls, attrs: { alt: '', draggable: 'false' } });
        const meta = assetId ? this.store.doc.assets.find((a) => a.id === assetId) : undefined;
        if (meta) {
            void getAssetUrl(meta).then((url) => {
                if (url) img.src = url;
                else img.classList.add('missing');
            });
            img.title = meta.name;
        } else img.classList.add('missing');
        return img;
    }

    private briefSection(): HTMLElement {
        const d = this.design;
        const rows: Node[] = [];
        if (d.brief.text.trim()) {
            const text = d.brief.text.trim();
            rows.push(h('div', { class: 'design-brief', text: text.length > 600 ? text.slice(0, 600) + '...' : text }));
            const changed = !!d.brief.structuredAt && d.brief.structured !== d.brief.text;
            if (changed) rows.push(h('div', { class: 'design-note warn' }, icon('alert', 14), h('span', { text: 'The brief changed since it was structured.' })));
        } else {
            rows.push(h('div', { class: 'muted small pad', text: d.brief.skipped ? 'This project works without a brief.' : 'No brief yet. Paste the planning document and drop the concept images.' }));
        }
        const changed = !!d.brief.structuredAt && d.brief.structured !== d.brief.text;
        rows.push(
            h(
                'div',
                { class: 'design-actions' },
                button(d.brief.text.trim() ? 'Edit brief' : 'Add brief', () => this.hooks.showBrief(), 'small', 'open'),
                button(changed ? 'Restructure' : d.brief.structuredAt ? 'Structure again' : 'Structure with AI', () => this.structure(), 'small', 'sparkle'),
            ),
        );

        // Concept images and their areas.
        const grid = h('div', { class: 'concept-grid' });
        const areas = [{ value: '', label: 'No area' }, ...d.areas.map((a) => ({ value: a.id, label: a.name }))];
        for (const c of d.concepts) {
            const sel = new SelectField<string>(areas, c.area ?? '', (v) => this.edit('Concept Area', (dd) => {
                const cc = dd.concepts.find((x) => x.asset === c.asset);
                if (cc) cc.area = v || null;
            }));
            const remove = iconButton('close', 'Remove concept', () => this.edit('Remove Concept', (dd) => {
                dd.concepts = dd.concepts.filter((x) => x.asset !== c.asset);
            }));
            const img = this.thumb(c.asset, 'concept-img');
            img.addEventListener('click', () => this.preview(c.asset));
            grid.appendChild(h('div', { class: 'concept-tile' }, img, h('div', { class: 'concept-meta' }, sel.el, remove)));
        }
        const add = h('button', { class: 'concept-add', attrs: { type: 'button' } }, icon('plus', 18), h('span', { text: 'Concept images' }));
        add.addEventListener('click', async () => {
            const files = await pickFiles('image/*', true);
            await addConcepts(this.editor, files);
        });
        grid.appendChild(add);
        rows.push(h('div', { class: 'group-label', text: `Concepts (${d.concepts.length})` }), grid);
        return section('design-brief', 'Brief & Concepts', 'open', rows);
    }

    /** Shows an image large in a popover. */
    private preview(assetId: string) {
        const img = this.thumb(assetId, 'design-preview-img');
        popover(this.el, h('div', { class: 'design-preview' }, img), 'wide');
    }

    // ---------------------------------------------------------------- plan

    private planSection(): HTMLElement {
        const d = this.design;
        const rows: Node[] = [];

        // Layout: how the scene is built.
        rows.push(h('div', { class: 'group-label', text: 'Layout' }));
        const layout = new TextAreaField(d.layout.summary, (v) => this.edit('Edit Layout', (dd) => (dd.layout.summary = v.trim())), 'How the scene is built: kind of place, size, ground, where the areas sit and how they connect.', 3);
        rows.push(layout.el);
        const size = new Vec3Field({ value: d.layout.size ?? [0, 0, 0], step: 0.5, precision: 1, commit: (v) => this.edit('Layout Size', (dd) => (dd.layout.size = v.some((x) => x > 0) ? v : null)) });
        rows.push(row('Size', size.el, 'Overall footprint x and z, height y (meters)'));
        for (const c of d.layout.connections) {
            rows.push(h('div', { class: 'design-line' }, icon('link', 12), h('span', { text: `${areaName(d, c.from)} - ${areaName(d, c.to)}${c.kind ? ` (${c.kind})` : ''}${c.note ? `: ${c.note}` : ''}` })));
        }

        // Areas.
        rows.push(h('div', { class: 'group-label', text: `Areas (${d.areas.length})` }));
        for (const a of d.areas) rows.push(this.areaItem(a));
        const addArea = new TextField('', (v) => {
            if (!v.trim()) return;
            this.edit('Add Area', (dd) => dd.areas.push({ id: uid('ar'), name: v.trim(), description: '', objects: [] }));
        }, 'Add an area...');
        rows.push(addArea.el);

        // Specs.
        rows.push(h('div', { class: 'group-label', text: 'Specs' }));
        const spec = (label: string, key: keyof DesignDoc['specs'], hint: string, step = 0.01) => {
            const f = new NumberField({ value: d.specs[key] as number, step, min: 0, precision: 2, commit: (v) => this.edit(`Spec: ${label}`, (dd) => ((dd.specs as any)[key] = v)) });
            rows.push(row(label, f.el, hint));
        };
        spec('Player Height', 'playerHeight', 'Height of the player (m)');
        spec('Eye Height', 'eyeHeight', 'Camera height of the walk view and player captures (m)');
        spec('Player Radius', 'playerRadius', 'Radius of the player capsule (m)');
        spec('Door Width', 'doorWidth', 'Clear width of doors and passages (m)');
        spec('Door Height', 'doorHeight', 'Clear height of doors (m)');
        spec('Step Height', 'stepHeight', 'Highest step the player climbs (m)');
        spec('Max Slope', 'maxSlope', 'Steepest walkable slope (degrees)', 0.5);
        const notes = new TextAreaField(d.specs.notes, (v) => this.edit('Spec Notes', (dd) => (dd.specs.notes = v)), 'Other measurements', 2);
        rows.push(notes.el);

        // Mood.
        rows.push(h('div', { class: 'group-label', text: 'Mood' }));
        const mood = new TextAreaField(d.mood.description, (v) => this.edit('Edit Mood', (dd) => (dd.mood.description = v.trim())), 'Atmosphere, weather, feeling', 2);
        const tod = new TextField(d.mood.timeOfDay, (v) => this.edit('Time of Day', (dd) => (dd.mood.timeOfDay = v.trim())), 'e.g. dusk, 17:30');
        const az = new NumberField({ value: d.mood.keyLight.azimuth, step: 0.5, precision: 1, commit: (v) => this.edit('Key Light Azimuth', (dd) => (dd.mood.keyLight.azimuth = v)) });
        const el = new NumberField({ value: d.mood.keyLight.elevation, step: 0.5, min: -90, max: 90, precision: 1, commit: (v) => this.edit('Key Light Elevation', (dd) => (dd.mood.keyLight.elevation = v)) });
        const kc = new ColorField({ value: d.mood.keyLight.color, commit: (v) => this.edit('Key Light Color', (dd) => (dd.mood.keyLight.color = v)) });
        const palette = h('div', { class: 'palette' }, d.mood.palette.map((c) => h('span', { class: 'swatch', title: c, style: { background: c } })));
        rows.push(mood.el, row('Time of Day', tod.el), row('Key Light', h('div', { class: 'inline' }, az.el, el.el), 'Azimuth (around +Y from +Z) and elevation, degrees'), row('Key Color', kc.el));
        rows.push(row('', button('Apply to the Sun', () => {
            this.editor.pipeline.applyKeyLight();
            toast('The key light and the sky\'s sun follow the mood now.', 'success');
        }, 'small', 'sun'), 'Points the first directional light and the sky\'s sun the way the key light comes from, with its color'));
        if (d.mood.palette.length) rows.push(row('Palette', palette));

        // Play requirements.
        rows.push(h('div', { class: 'group-label', text: 'Play' }));
        rows.push(...this.routeRows(), ...this.sightlineRows());
        if (d.play.areaOrder.length) rows.push(row('Area Order', h('div', { class: 'readonly', text: d.play.areaOrder.map((id) => areaName(d, id)).join(' > ') })));
        const playNotes = new TextAreaField(d.play.notes, (v) => this.edit('Play Notes', (dd) => (dd.play.notes = v)), 'Other play requirements', 2);
        rows.push(playNotes.el);

        // Effects.
        rows.push(h('div', { class: 'group-label', text: `Effects (${d.effects.length})` }));
        for (const fx of d.effects) {
            const done = new CheckboxField(!!fx.done, (v) => this.edit(v ? 'Effect Done' : 'Effect Not Done', (dd) => {
                const e = dd.effects.find((x) => x.id === fx.id);
                if (e) e.done = v || undefined;
            }), `${fx.name}${fx.area ? ` (${areaName(d, fx.area)})` : ''}`);
            const remove = iconButton('close', 'Remove effect', () => this.edit('Remove Effect', (dd) => (dd.effects = dd.effects.filter((x) => x.id !== fx.id))));
            rows.push(h('div', { class: 'design-line' }, done.el, h('div', { class: 'spacer' }), remove));
        }
        const addFx = new TextField('', (v) => {
            if (v.trim()) this.edit('Add Effect', (dd) => dd.effects.push({ id: uid('fx'), name: v.trim() }));
        }, 'Add an effect...');
        rows.push(addFx.el);

        // Budget.
        rows.push(h('div', { class: 'group-label', text: 'Budget' }));
        const shadows = new NumberField({ value: d.budget.shadowLights, step: 0.1, min: 0, precision: 0, commit: (v) => this.edit('Shadow Light Budget', (dd) => (dd.budget.shadowLights = Math.round(v))) });
        const fps = new NumberField({ value: d.budget.fps, step: 0.5, min: 1, precision: 0, commit: (v) => this.edit('Frame Rate Budget', (dd) => (dd.budget.fps = Math.round(v))) });
        rows.push(row('Shadow Lights', shadows.el, 'Most lights that cast shadows'), row('Frame Rate', fps.el, 'Frames per second to keep'));

        // Questions.
        if (d.questions.length) {
            rows.push(h('div', { class: 'group-label', text: `Questions (${d.questions.filter((q) => !q.answer.trim()).length} open)` }));
            for (const q of d.questions) {
                const answer = new TextAreaField(q.answer, (v) => this.edit('Answer Question', (dd) => {
                    const qq = dd.questions.find((x) => x.id === q.id);
                    if (qq) qq.answer = v.trim();
                }), 'Your answer', 2);
                const remove = iconButton('close', 'Remove question', () => this.edit('Remove Question', (dd) => (dd.questions = dd.questions.filter((x) => x.id !== q.id))));
                rows.push(h('div', { class: 'design-question' + (q.answer.trim() ? ' answered' : '') }, h('div', { class: 'design-line' }, h('span', { class: 'design-q', text: q.text }), remove), answer.el));
            }
            if (d.questions.some((q) => q.answer.trim())) {
                rows.push(button('Send the answers to the assistant', () => this.hooks.ask('I answered the questions in the design panel (see the answered questions in the context). Update the structure with update_design accordingly.'), 'small', 'send'));
            }
        }
        return section('design-plan', 'Plan', 'layers', rows);
    }

    private areaItem(a: AreaDoc): HTMLElement {
        const d = this.design;
        const open = this.openAreas.has(a.id);
        const concepts = d.concepts.filter((c) => c.area === a.id).length;
        const placed = a.objects.filter((o) => o.placed).length;
        const head = h(
            'button',
            { class: 'slot-head' + (open ? ' open' : ''), attrs: { type: 'button' } },
            icon('chevron', 12, 'slot-caret'),
            h('span', { class: 'slot-name', text: a.name }),
            a.rework ? h('span', { class: 'slot-tag warn', text: `rework: ${stageDef(a.rework).title}` }) : null,
            h('span', { class: 'slot-count', text: `${a.objects.length} obj · ${concepts} img`, title: `${placed} of ${a.objects.length} objects ticked as placed, ${concepts} concept images` }),
        );
        head.addEventListener('click', () => {
            if (open) this.openAreas.delete(a.id);
            else this.openAreas.add(a.id);
            this.schedule(true);
        });
        const item = h('div', { class: 'slot-item' }, head);
        if (!open) return item;
        const set = (label: string, fn: (area: AreaDoc) => void) => this.edit(label, (dd) => {
            const area = dd.areas.find((x) => x.id === a.id);
            if (area) fn(area);
        });
        const name = new TextField(a.name, (v) => v.trim() && set('Rename Area', (x) => (x.name = v.trim())));
        const desc = new TextAreaField(a.description, (v) => set('Area Description', (x) => (x.description = v.trim())), 'What the area is', 2);
        const mood = new TextAreaField(a.mood ?? '', (v) => set('Area Mood', (x) => (x.mood = v.trim() || undefined)), 'Mood when it differs from the scene', 2);
        const objects = h('div', { class: 'design-objects' });
        a.objects.forEach((o, i) => {
            const placedBox = new CheckboxField(!!o.placed, (v) => set(v ? 'Object Placed' : 'Object Not Placed', (x) => {
                if (x.objects[i]) x.objects[i].placed = v || undefined;
            }), `${o.name}${o.count && o.count > 1 ? ` x${o.count}` : ''}`);
            placedBox.el.title = o.note ?? 'Ticked when it is placed in the level';
            const remove = iconButton('close', 'Remove object', () => set('Remove Object', (x) => x.objects.splice(i, 1)));
            objects.appendChild(h('div', { class: 'design-line' }, placedBox.el, h('div', { class: 'spacer' }), remove));
        });
        const addObj = new TextField('', (v) => v.trim() && set('Add Object', (x) => x.objects.push({ name: v.trim() })), 'Add an object...');
        const center = new Vec3Field({ value: a.bounds?.center ?? [0, 0, 0], step: 0.1, precision: 2, commit: (v) => set('Area Bounds', (x) => (x.bounds = { center: v, size: x.bounds?.size ?? [10, 4, 10] })) });
        const size = new Vec3Field({ value: a.bounds?.size ?? [0, 0, 0], step: 0.1, precision: 2, commit: (v) => set('Area Bounds', (x) => (x.bounds = v.some((s) => s > 0) ? { center: x.bounds?.center ?? [0, 0, 0], size: v.map((s) => Math.max(0.1, s)) as Vec3 } : null)) });
        const remove = button('Remove area', async () => {
            if (await confirmDialog('Remove area', `Remove ${a.name} from the plan? The objects in the scene stay.`, 'Remove', true)) {
                this.edit('Remove Area', (dd) => {
                    dd.areas = dd.areas.filter((x) => x.id !== a.id);
                    for (const c of dd.concepts) if (c.area === a.id) c.area = null;
                });
            }
        }, 'small subtle', 'trash');
        item.appendChild(
            h(
                'div',
                { class: 'slot-body' },
                row('Name', name.el),
                desc.el,
                mood.el,
                h('div', { class: 'group-label', text: 'Objects' }),
                objects,
                addObj.el,
                row('Center', center.el, 'Rough placement for the greybox (m)'),
                row('Size', size.el),
                row('', remove),
            ),
        );
        return item;
    }

    private routeRows(): Node[] {
        const d = this.design;
        const rows: Node[] = [];
        const areas = [{ value: '', label: 'No area' }, ...d.areas.map((a) => ({ value: a.id, label: a.name }))];
        d.play.route.forEach((p, i) => {
            const visited = new CheckboxField(!!p.visited, (v) => this.edit(v ? 'Route Point Reached' : 'Route Point Not Reached', (dd) => {
                const pt = dd.play.route.find((x) => x.id === p.id);
                if (pt) pt.visited = v || undefined;
            }), `${i + 1}. ${p.name}`);
            visited.el.title = p.note ?? 'Ticked when the walk camera passes it';
            const area = new SelectField<string>(areas, p.area ?? '', (v) => this.edit('Route Point Area', (dd) => {
                const pt = dd.play.route.find((x) => x.id === p.id);
                if (pt) pt.area = v || null;
            }));
            const place = iconButton('focus', 'Set to the orbit target of the view', () => {
                const t = this.store.camera.target;
                this.edit('Route Point Position', (dd) => {
                    const pt = dd.play.route.find((x) => x.id === p.id);
                    if (pt) pt.position = [round(t[0]), 0, round(t[2])];
                });
            });
            const remove = iconButton('close', 'Remove point', () => this.edit('Remove Route Point', (dd) => (dd.play.route = dd.play.route.filter((x) => x.id !== p.id))));
            rows.push(h('div', { class: 'design-line' }, visited.el, h('div', { class: 'spacer' }), p.position ? h('span', { class: 'muted small', text: p.position.map((v) => v.toFixed(1)).join(', ') }) : null, place, area.el, remove));
        });
        const add = new TextField('', (v) => v.trim() && this.edit('Add Route Point', (dd) => dd.play.route.push({ id: uid('rp'), name: v.trim() })), 'Add a route point...');
        rows.unshift(h('div', { class: 'muted small', text: `Route (${d.play.route.length} points)` }));
        rows.push(add.el);
        return rows;
    }

    private sightlineRows(): Node[] {
        const d = this.design;
        const rows: Node[] = [h('div', { class: 'muted small', text: `Sight lines (${d.play.sightlines.length})` })];
        for (const v of d.play.sightlines) {
            const state = new SelectField<string>(
                [
                    { value: '', label: 'Not checked' },
                    { value: 'yes', label: 'Clear' },
                    { value: 'no', label: 'Blocked' },
                ],
                v.ok === true ? 'yes' : v.ok === false ? 'no' : '',
                (val) => this.edit('Sight Line', (dd) => {
                    const s = dd.play.sightlines.find((x) => x.id === v.id);
                    if (s) s.ok = val === 'yes' ? true : val === 'no' ? false : null;
                }),
            );
            const remove = iconButton('close', 'Remove sight line', () => this.edit('Remove Sight Line', (dd) => (dd.play.sightlines = dd.play.sightlines.filter((x) => x.id !== v.id))));
            rows.push(h('div', { class: 'design-line' }, h('span', { class: 'design-sightline', text: `${areaName(d, v.from)} -> ${areaName(d, v.to)}`, title: v.note ?? '' }), h('div', { class: 'spacer' }), state.el, remove));
        }
        return rows;
    }

    // --------------------------------------------------------------- shots

    private shotsSection(): HTMLElement {
        const d = this.design;
        const pipeline = this.editor.pipeline;
        const rows: Node[] = [];
        for (const shot of d.shots) rows.push(this.shotItem(shot));
        if (!d.shots.length) rows.push(h('div', { class: 'muted small pad', text: 'Shots are camera bookmarks framed like the concept images. Frame the view and add one, or make one per concept.' }));
        const missing = d.concepts.filter((c) => !d.shots.some((s) => s.concept === c.asset));
        const actions = h('div', { class: 'design-actions' }, button('Shot from view', () => {
            const shot = pipeline.createShot();
            pipeline.showShot(shot.id, false);
        }, 'small', 'camera'));
        if (missing.length) {
            actions.appendChild(button(`Shot for a concept (${missing.length})`, (e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                showMenu(
                    missing.map((c) => ({
                        label: `${this.assetName(c.asset)}${c.area ? ` (${areaName(d, c.area)})` : ''}`,
                        icon: 'image',
                        action: () => {
                            const shot = pipeline.createShot({ concept: c.asset, name: c.area ? areaName(d, c.area) : undefined });
                            pipeline.showShot(shot.id, false);
                            toast('Frame the view to match the concept, then use "Update" in the shot bar.', 'info', 5000);
                        },
                    })),
                    r.left,
                    r.bottom + 4,
                );
            }, 'small', 'image'));
        }
        rows.push(actions);
        return section('design-shots', `Shots (${d.shots.length})`, 'camera', rows);
    }

    private shotItem(shot: ShotDoc): HTMLElement {
        const pipeline = this.editor.pipeline;
        const d = this.design;
        const active = pipeline.activeShot === shot.id;
        const last = shot.history[shot.history.length - 1];
        const img = this.thumb(shot.target ?? shot.concept ?? last?.asset ?? null, 'shot-thumb');
        img.addEventListener('click', () => pipeline.showShot(active ? null : shot.id));
        const badges: HTMLElement[] = [];
        if (shot.target) badges.push(h('span', { class: 'shot-badge ok', text: 'target' }));
        else badges.push(h('span', { class: 'shot-badge', text: 'no target' }));
        if (shot.stale) badges.push(h('span', { class: 'shot-badge warn', text: 'needs update', title: 'The level was reopened after this paintover was chosen' }));
        if (shot.approved) badges.push(h('span', { class: 'shot-badge ok', text: 'approved' }));
        const stage = stageDef(d.stage);
        if (stage.matchLabel && shot.target) {
            const ok = !!shot.matched?.includes(d.stage);
            badges.push(h('span', { class: 'shot-badge' + (ok ? ' ok' : ''), text: ok ? 'matches' : 'to compare', title: stage.matchLabel }));
        }
        const lastScore = [...shot.history].reverse().find((c) => c.score != null);
        if (lastScore) badges.push(h('span', { class: 'shot-badge', text: `score ${Math.round(lastScore.score!)}`, title: `Last comparison (${lastScore.compare ?? 'gray'}, ${stageDef(lastScore.stage).title})` }));
        const name = new TextField(shot.name, (v) => v.trim() && pipeline.updateShot(shot.id, { name: v.trim() }, 'Rename Shot'));
        const menu = iconButton('dots', 'Shot options', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                [
                    { label: active ? 'Hide Frame' : 'Show', icon: 'camera', action: () => pipeline.showShot(active ? null : shot.id) },
                    { label: 'Update from View', icon: 'focus', enabled: () => active, action: () => pipeline.updateShotFromView(shot.id) },
                    { label: 'Capture Now', icon: 'image', action: () => void this.captureNow(shot) },
                    { label: 'Paintovers...', icon: 'paint', action: () => openPaintoverDialog(this.editor, shot.id) },
                    { label: 'Compare with Target', icon: 'graph', enabled: () => !!(shot.target || shot.concept), action: () => pipeline.openCompare(shot.id) },
                    { label: 'History', icon: 'history', enabled: () => shot.history.length > 0, action: () => this.showHistory(shot, img) },
                    { separator: true },
                    {
                        label: 'Area',
                        submenu: [{ id: '', name: 'No area' }, ...d.areas].map((a) => ({
                            label: a.name,
                            checked: () => (shot.area ?? '') === a.id,
                            action: () => pipeline.updateShot(shot.id, { area: a.id || null }, 'Shot Area'),
                        })),
                    },
                    { label: shot.approved ? 'Withdraw Approval' : 'Approve (final)', icon: 'check', action: () => pipeline.updateShot(shot.id, { approved: !shot.approved }, shot.approved ? 'Withdraw Shot Approval' : 'Approve Shot') },
                    { separator: true },
                    { label: 'Delete Shot', icon: 'trash', action: () => pipeline.deleteShot(shot.id) },
                ],
                r.left - 160,
                r.bottom + 4,
            );
        });
        return h(
            'div',
            { class: 'shot-item' + (active ? ' active' : '') },
            img,
            h(
                'div',
                { class: 'shot-info' },
                h('div', { class: 'inline' }, name.el, menu),
                h('div', { class: 'shot-badges' }, badges, shot.area ? h('span', { class: 'muted small', text: areaName(d, shot.area) }) : null),
                h(
                    'div',
                    { class: 'inline' },
                    button(active ? 'Showing' : 'Show', () => pipeline.showShot(active ? null : shot.id), 'small' + (active ? ' primary' : ''), 'camera'),
                    button(generating(shot.id) ? 'Painting...' : `Paintover${shot.paintovers.length ? ` (${shot.paintovers.length})` : ''}`, () => openPaintoverDialog(this.editor, shot.id), 'small', 'paint'),
                ),
            ),
        );
    }

    private async captureNow(shot: ShotDoc) {
        try {
            const meta = await this.editor.pipeline.captureShotAsset(shot.id, 'capture');
            toast(`Captured ${meta.name}.`, 'success');
            this.preview(meta.id);
        } catch (e: any) {
            toast(`Capture failed: ${e?.message || e}`, 'error');
        }
    }

    private showHistory(shot: ShotDoc, anchor: HTMLElement) {
        const strip = h('div', { class: 'shot-history' });
        const add = (asset: string | null | undefined, label: string) => {
            if (!asset) return;
            const img = this.thumb(asset, 'shot-history-img');
            strip.appendChild(h('figure', null, img, h('figcaption', { text: label })));
        };
        add(shot.concept, 'Concept');
        add(shot.target, 'Target');
        for (const c of shot.history) add(c.asset, `${stageDef(c.stage).title}${c.manual ? '' : ' done'} ${c.at.slice(5, 16).replace('T', ' ')}${c.score != null ? ` · ${Math.round(c.score)}` : ''}`);
        popover(anchor, h('div', { class: 'design-preview' }, h('div', { class: 'pipeline-popover-title', text: shot.name }), strip), 'wide');
    }

    // ------------------------------------------------------------ materials

    private materialsSection(): HTMLElement {
        const d = this.design;
        const rows: Node[] = [];
        for (const slot of d.materials) rows.push(this.slotItem(slot));
        if (!d.materials.length) {
            rows.push(h('div', { class: 'muted small pad', text: 'Material slots are the named surfaces of the level (plaster, cobblestone, wood). Each gets a swatch from the library, shown with the world space triplanar shader at its real size.' }));
        }
        rows.push(
            h(
                'div',
                { class: 'design-actions' },
                button('Add slot', () => {
                    const slot = upsertSlot(this.editor, { name: `Material ${d.materials.length + 1}` });
                    this.openSlots.add(slot.id);
                    this.schedule(true);
                }, 'small', 'plus'),
                button('Swatch library', () => openSwatchDialog(this.editor, null), 'small', 'image'),
                d.materials.length
                    ? button('Reference room', () => void this.editor.room?.open(d.materials.map((m) => roomSample(this.store.doc, m))), 'small', 'sun')
                    : null,
            ),
        );
        return section('design-materials', `Material Slots (${d.materials.length})`, 'sliders', rows);
    }

    private slotItem(slot: MaterialSlotDoc): HTMLElement {
        const open = this.openSlots.has(slot.id);
        const users = slotUsers(this.store.doc, slot.id);
        const thumb = slot.swatch ? this.thumb(slot.swatch, 'slot-swatch') : h('span', { class: 'slot-swatch plain', style: { background: slot.color } });
        const head = h(
            'button',
            { class: 'slot-head' + (open ? ' open' : ''), attrs: { type: 'button' } },
            icon('chevron', 12, 'slot-caret'),
            thumb,
            h('span', { class: 'slot-name', text: slot.name }),
            !slot.swatch && !slot.flat ? h('span', { class: 'slot-tag warn', text: 'no swatch' }) : null,
            h('span', { class: 'slot-count', text: `${users.length} obj`, title: `${users.length} objects use this slot` }),
        );
        head.addEventListener('click', () => {
            if (open) this.openSlots.delete(slot.id);
            else this.openSlots.add(slot.id);
            this.schedule(true);
        });
        const item = h('div', { class: 'slot-item' }, head);
        if (!open) return item;
        const set = (patch: SlotPatch, label = 'Edit Material Slot') => upsertSlot(this.editor, { id: slot.id, ...patch }, label);
        const name = new TextField(slot.name, (v) => v.trim() && set({ name: v.trim() }, 'Rename Material Slot'));
        const desc = new TextAreaField(slot.description, (v) => set({ description: v.trim() }), 'What the surface is: material, color, wear', 2);
        const color = new ColorField({ value: slot.color, commit: (v) => set({ color: v }) });
        const tile = new NumberField({ value: slot.tile, min: 0.05, max: 100, step: 0.05, precision: 2, commit: (v) => set({ tile: v }) });
        const rough = new SliderField({ value: slot.roughness, min: 0, max: 1, step: 0.01, precision: 2, commit: (v) => set({ roughness: v }) });
        const metal = new SliderField({ value: slot.metallic, min: 0, max: 1, step: 0.01, precision: 2, commit: (v) => set({ metallic: v }) });
        const flat = new CheckboxField(!!slot.flat, (v) => set({ flat: v }, v ? 'Plain Color Slot' : 'Swatch Slot'), 'Plain color, no swatch needed');
        const sel = this.store.selection.filter((id) => this.store.node(id)?.mesh || this.store.node(id)?.prefab);
        item.append(
            h(
                'div',
                { class: 'slot-body' },
                row('Name', name.el),
                desc.el,
                row('Tile', tile.el, 'Size of one texture tile in meters'),
                row('Color', color.el, 'Multiplies the swatch; white shows it as it is'),
                row('Roughness', rough.el),
                row('Metallic', metal.el),
                row('', flat.el),
                h(
                    'div',
                    { class: 'design-actions' },
                    button(slot.swatch ? 'Change swatch' : 'Find a swatch', () => openSwatchDialog(this.editor, slot.id), 'small primary', 'image'),
                    button(`Assign to selection${sel.length ? ` (${sel.length})` : ''}`, () => {
                        if (!sel.length) return toast('Select objects in the viewport or the hierarchy first.', 'info');
                        const n = assignSlot(this.editor, slot.id, sel);
                        toast(`${n} surface${n === 1 ? '' : 's'} use ${slot.name} now.`, 'success');
                    }, 'small', 'check'),
                    users.length ? button('Select users', () => this.store.select(users.map((u) => u.id)), 'small', 'cursor') : null,
                    iconButton('trash', 'Delete slot (the objects keep their look)', async () => {
                        if (await confirmDialog('Delete material slot', `Delete ${slot.name}? ${users.length} objects keep their current look.`, 'Delete', true)) deleteSlot(this.editor, slot.id);
                    }),
                ),
            ),
        );
        return item;
    }

    // ------------------------------------------------------------ snapshots

    private snapshotSection(): HTMLElement {
        const pipeline = this.editor.pipeline;
        const d = this.design;
        const rows: Node[] = [];
        for (const s of [...d.snapshots].reverse()) {
            const menu = iconButton('dots', 'Snapshot options', (e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                showMenu(
                    [
                        { label: 'Restore', icon: 'undo', action: () => void pipeline.restoreSnapshot(s.id) },
                        {
                            label: 'Download Scene File',
                            icon: 'save',
                            action: async () => {
                                const file = await pipeline.readSnapshot(s);
                                if (!file) return toast('This snapshot is not stored in this browser.', 'error');
                                download(new Blob([JSON.stringify({ ...file.scene, camera: file.camera })], { type: 'application/json' }), `${s.name.replace(/[^\w-]+/g, '-')}.scene.json`);
                            },
                        },
                        { separator: true },
                        { label: 'Delete', icon: 'trash', action: () => pipeline.deleteSnapshot(s.id) },
                    ],
                    r.left - 160,
                    r.bottom + 4,
                );
            });
            rows.push(
                h(
                    'div',
                    { class: 'design-line' },
                    icon('history', 13),
                    h('span', { class: 'snapshot-name', text: s.name }),
                    h('span', { class: 'muted small', text: s.at.slice(0, 16).replace('T', ' ') }),
                    h('div', { class: 'spacer' }),
                    menu,
                ),
            );
        }
        if (!d.snapshots.length) rows.push(h('div', { class: 'muted small pad', text: 'Completing a stage takes a snapshot of the scene. Restore brings the scene back to it.' }));
        rows.push(button('Take Snapshot', () => void pipeline.takeSnapshot('Snapshot').then(() => toast('Snapshot taken.', 'success')), 'small', 'history'));
        return section('design-snapshots', `Snapshots (${d.snapshots.length})`, 'history', rows);
    }

    // ----------------------------------------------------------------- memo

    private memoSection(): HTMLElement {
        const d = this.design;
        const memo = new TextAreaField(d.memo.text, (v) => this.edit('Edit Scene Memo', (dd) => (dd.memo = { text: v.trim(), at: new Date().toISOString() })), 'A few lines about where the work stands. The assistant reads this with every request and refreshes it at checkpoints.', 5);
        return section('design-memo', 'Scene Memo', 'sparkle', [
            memo.el,
            h('div', { class: 'muted small', text: d.memo.at ? `Updated ${d.memo.at.slice(0, 16).replace('T', ' ')}` : 'Not written yet.' }),
        ]);
    }
}

function round(v: number): number {
    return Math.round(v * 100) / 100;
}

/** Stores images as concept images of the project. */
export async function addConcepts(editor: Editor, files: File[]): Promise<AssetMeta[]> {
    const metas: AssetMeta[] = [];
    for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        try {
            metas.push(await putDesignImage(f, f.name || 'concept.png'));
        } catch (e: any) {
            toast(`Could not read ${f.name}: ${e?.message || e}`, 'error');
        }
    }
    if (!metas.length) return metas;
    editor.store.commit(metas.length === 1 ? 'Add Concept' : `Add ${metas.length} Concepts`, (d) => {
        d.assets.push(...metas);
        for (const m of metas) d.design.concepts.push({ asset: m.id, area: null });
    }, { design: true });
    return metas;
}
