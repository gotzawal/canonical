import type { z } from 'zod';
import type { Editor } from '../editor';
import { onChanges, touches } from './batch';
import { Environment } from '../core/model';
import { QUALITY } from '../core/quality';
import { describeShadowCost, shadowCasters, shadowCost } from '../engine/shadows';
import { inner } from '../core/schema';
import type { EnvironmentDoc, SkyType, StageId } from '../core/types';
import { stageDef } from '../design/stages';
import { clear, h } from './dom';
import { schemaRows } from './schemaFields';
import { CheckboxField, EditHooks, FieldSteps, NumberField, SelectField, SliderField, TextField, button, row, section } from './widgets';

type Group = 'bloom' | 'ao' | 'ssr' | 'fog' | 'gi' | 'shadow' | 'godRays' | 'volumetricFog' | 'atmosphere';

/** The stage a section's settings are made in, shown in its header. */
function stageChip(stage: StageId): HTMLElement {
    const title = stageDef(stage).title;
    return h('span', { class: 'stage-chip', text: title, title: `Set in the ${title} stage` });
}

/** What the sky models are, under their choice. */
const SKY_NOTES: Record<SkyType, string> = {
    atmospheric: 'Single scattering: sunlight scattered once by the air, haze and ozone. Quick to redraw; right for day skies, while sunsets and dusk come out darker and flatter.',
    physical: 'Multiple scattering (Hillaire): light scattered many times, from precomputed tables. Deep sunsets, dusk and twilight glow, and optional clouds; each change of the sky takes longer to redraw.',
    color: 'One flat color without a sun: interiors and stylized scenes. The color lights the scene too.',
    hdri: 'A photographed sky and surroundings (an .hdr image, such as a Library HDRI) shown around the scene and lighting it: the most realistic light. Point the key light where its sun is.',
};

/**
 * Scene-wide settings, in the order of the stages that make them: the sun,
 * exposure, shadows and GI (Lighting), then the sky model and the post
 * effects (Effects), and editor preferences.
 */
export class ScenePanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private syncs: (() => void)[] = [];
    private sky: SkyType | null = null;
    private giOn: boolean | null = null;
    private fogMode: string | null = null;
    private steps: FieldSteps;
    private fov: SliderField | null = null;
    /** Updates the line on what the shadow maps take. */
    private shadowNote: (() => void) | null = null;

    constructor(private editor: Editor) {
        this.steps = new FieldSteps(editor.store);
        this.body = h('div', { class: 'panel-body' });
        this.el = h('div', { class: 'panel scene-panel' }, this.body);
        onChanges(editor.store, (hint) => {
            // Lights change what the shadow maps take.
            if (!touches(hint, 'env')) {
                if (hint?.nodes || !hint) this.shadowNote?.();
                return;
            }
            const env = editor.store.doc.environment;
            if (env.sky !== this.sky || env.gi.enable !== this.giOn || env.fog.mode !== this.fogMode) this.render();
            else for (const s of this.syncs) s();
        });
        editor.store.on('load', () => this.render());
        editor.store.on('prefs', () => {
            for (const s of this.syncs) s();
        });
        editor.store.on('camera', (cam) => this.fov?.set(cam.fov));
        this.render();
    }

    /** Opens a section (by its key) and brings it into view. */
    reveal(key: string) {
        const el = this.body.querySelector<HTMLElement>(`section[data-section="${key}"]`);
        if (!el) return;
        if (el.classList.contains('collapsed')) el.querySelector<HTMLElement>('.section-header')?.click();
        el.scrollIntoView({ block: 'start' });
        el.classList.remove('revealed');
        void el.offsetWidth;
        el.classList.add('revealed');
    }

    private get env(): EnvironmentDoc {
        return this.editor.store.doc.environment;
    }

    private hooks<T>(label: string, apply: (env: EnvironmentDoc, v: T) => void): EditHooks<T> {
        const store = this.editor.store;
        return this.steps.hooks(label, (v: T) => store.update((doc) => apply(doc.environment, v), { env: true }));
    }

    /** The HDRI sky's image: one of the project's .hdr files (a Library HDRI adds one). */
    private hdriRow(watch: (fn: () => void) => void): HTMLElement {
        const store = this.editor.store;
        const options = () => [
            { value: '', label: 'None' },
            ...store.doc.assets.filter((a) => /\.hdr$/i.test(a.name)).map((a) => ({ value: a.id, label: a.name })),
        ];
        const field = new SelectField(options(), this.env.skyHdri ?? '', (v) => store.commit('HDRI Sky', (doc) => (doc.environment.skyHdri = v || null), { env: true }));
        watch(() => field.set(this.env.skyHdri ?? ''));
        const hint = store.doc.assets.some((a) => /\.hdr$/i.test(a.name)) ? null : h('div', { class: 'muted small', text: 'Add an HDRI from the Library (Assets > Library, HDRIs).' });
        return h('div', {}, row('HDRI', field.el), hint);
    }

    /** Rows for fields of the environment (or one of its groups) from its schema; an edit repairs what it changed. */
    private rows(keys: string[], group?: Group): HTMLElement[] {
        const schema = group ? Environment.shape[group] : Environment;
        const get = (e: EnvironmentDoc): Record<string, unknown> => (group ? e[group] : e);
        const fields = schemaRows(inner(schema) as z.ZodObject, keys, get(this.env), (key, label) =>
            this.hooks(label, (e, v) => {
                const next = schema.parse({ ...get(e), [key]: v });
                if (group) (e as any)[group] = next;
                else Object.assign(e, next);
            }),
        );
        this.syncs.push(() => fields.set(get(this.env)));
        return fields.rows;
    }

    private render() {
        this.steps.close();
        clear(this.body);
        this.syncs = [];
        const env = this.env;
        this.sky = env.sky;
        this.giOn = env.gi.enable;
        this.fogMode = env.fog.mode;
        const store = this.editor.store;
        const watch = (fn: () => void) => this.syncs.push(fn);

        // Scene
        const name = new TextField(store.doc.name, (v) => store.commit('Rename Scene', (doc) => (doc.name = v.trim() || 'Untitled Scene'), { env: true }));
        watch(() => name.set(store.doc.name));
        this.body.append(section('scene', 'Scene', 'layers', [row('Name', name.el), ...this.rows(['quality'])]));

        // The sun and the sky's brightness (Lighting)
        const sunSky = env.sky !== 'color';
        this.body.append(
            section('sky', sunSky ? 'Sun and Sky' : 'Sky', 'sun', [
                ...(env.sky === 'hdri' ? [this.hdriRow(watch)] : []),
                ...this.rows([...(sunSky ? ['sunX', 'sunY'] : ['skyColor']), 'skyExposure']),
                // The sun disc and the air.
                ...(sunSky && env.sky !== 'hdri' ? this.rows(['sunSize', 'sunBrightness', 'showSun', 'altitude'], 'atmosphere') : []),
            ], [stageChip('light')]),
        );

        // Camera & tone mapping
        const fov = (this.fov = new SliderField({
            value: store.camera.fov,
            min: 15,
            max: 110,
            step: 1,
            precision: 0,
            input: (v) => store.setCamera({ ...store.camera, fov: v }),
            commit: (v) => store.setCamera({ ...store.camera, fov: v }),
        }));
        this.body.append(section('camera', 'Camera', 'focus', [...this.rows(['exposure']), row('Field of View', fov.el)], [stageChip('light')]));
        // Each light sizes and covers its own shadow map (the inspector's light section).
        const cost = h('div', { class: 'muted small pad' });
        const note = () => {
            const tier = QUALITY[this.editor.runtime.qualityLevel];
            cost.textContent = `${describeShadowCost(shadowCost(shadowCasters(store.doc), tier))} at the ${this.editor.runtime.qualityLevel} tier. Each light sets its own shadow: its size, when it is drawn again and, for a directional light, what it covers (one map, around the camera, or cascades).`;
        };
        note();
        watch(note);
        this.shadowNote = note;
        this.body.append(section('shadows', 'Shadows', 'sun', [...this.rows(['softness'], 'shadow'), cost], [stageChip('light')]));
        this.body.append(this.giSection(watch));

        // The sky's physical model (Effects)
        this.body.append(
            section('skyModel', 'Sky Model', 'sun', [
                ...this.rows(['sky']),
                ...(env.sky === 'physical' ? this.rows(['clouds'], 'atmosphere') : []),
                h('div', { class: 'muted small pad', text: SKY_NOTES[env.sky] }),
            ], [stageChip('effects')]),
        );

        // Post processing (Effects)
        const label = (text: string) => h('div', { class: 'group-label', text });
        this.body.append(
            section('post', 'Post Processing', 'sliders', [
                ...this.rows(['fxaa', 'fxaaSpan']),
                label('Bloom'),
                ...this.rows(['enable', 'intensity', 'threshold', 'levels', 'blur'], 'bloom'),
                label('Ambient Occlusion'),
                ...this.rows(['enable', 'strength', 'distance'], 'ao'),
                label('Screen Space Reflections'),
                ...this.rows(['enable', 'strength', 'roughness', 'distance', 'resolution', 'reach'], 'ssr'),
                label('Fog'),
                ...this.rows(['enable', 'mode', 'color', 'near', ...(env.fog.mode === 'linear' ? ['far'] : ['density']), ...(env.fog.mode === 'height' ? ['height', 'heightFalloff'] : []), 'intensity', 'sky', 'sunScatter', 'sunFocus'], 'fog'),
                label('Volumetric Fog'),
                ...this.rows(['enable', 'density', 'scattering', 'anisotropy', 'distance', 'ambient'], 'volumetricFog'),
                label('God Rays'),
                ...this.rows(['enable', 'intensity', 'focus'], 'godRays'),
            ], [stageChip('effects')]),
        );

        // Editor preferences (not part of the scene)
        const prefs = store.prefs;
        const grid = new CheckboxField(prefs.grid, (v) => store.setPrefs({ grid: v }));
        const helpers = new CheckboxField(prefs.helpers, (v) => store.setPrefs({ helpers: v }));
        const snapMove = new NumberField({ value: prefs.snapMove, step: 0.01, min: 0.001, precision: 3, commit: (v) => store.setPrefs({ snapMove: v }), input: (v) => store.setPrefs({ snapMove: v }) });
        const snapRotate = new NumberField({ value: prefs.snapRotate, step: 0.25, min: 0.1, precision: 2, commit: (v) => store.setPrefs({ snapRotate: v }), input: (v) => store.setPrefs({ snapRotate: v }) });
        const snapScale = new NumberField({ value: prefs.snapScale, step: 0.01, min: 0.001, precision: 3, commit: (v) => store.setPrefs({ snapScale: v }), input: (v) => store.setPrefs({ snapScale: v }) });
        watch(() => {
            const p = store.prefs;
            grid.set(p.grid);
            helpers.set(p.helpers);
            snapMove.set(p.snapMove);
            snapRotate.set(p.snapRotate);
            snapScale.set(p.snapScale);
        });
        this.body.append(
            section('editor', 'Editor', 'grid', [
                row('Grid', grid.el),
                row('Helpers', helpers.el, 'Light and empty object icons'),
                row('Snap Move', snapMove.el),
                row('Snap Rotate', snapRotate.el),
                row('Snap Scale', snapScale.el),
            ]),
        );
    }

    /** Dynamic diffuse global illumination: a grid of probes that bounces light between surfaces. */
    private giSection(watch: (fn: () => void) => void): HTMLElement {
        const store = this.editor.store;
        const rows = this.rows(['enable'], 'gi');
        if (!this.env.gi.enable) {
            rows.push(h('div', { class: 'muted small pad', text: 'Light bounces between surfaces through a grid of light probes, so colored walls tint what is next to them and shaded areas get indirect light. Works in the viewport, in Play mode and in builds.' }));
            return section('gi', 'Global Illumination', 'sun', rows, [stageChip('light')]);
        }
        const probes = new CheckboxField(store.prefs.giProbes, (v) => store.setPrefs({ giProbes: v }), 'Editor only');
        const info = h('div', { class: 'readonly' });
        const error = h('div', { class: 'readonly error-text' });
        const refresh = () => {
            const g = this.env.gi;
            const n = g.counts[0] * g.counts[1] * g.counts[2];
            const size = g.counts.map((c) => ((c - 1) * g.spacing).toFixed(1)).join(' x ');
            info.textContent = `${n} probes covering ${size}`;
            error.textContent = this.editor.runtime.gi.error;
            error.hidden = !error.textContent;
        };
        refresh();
        watch(() => {
            probes.set(store.prefs.giProbes);
            refresh();
        });
        rows.push(
            ...this.rows(['center', 'counts', 'spacing'], 'gi'),
            row('', info),
            ...this.rows(['intensity', 'bounce', 'realtime', 'probesPerFrame', 'updateEvery'], 'gi'),
            row('Show Probes', probes.el, 'Draw a sphere per probe with the light it captured'),
            row('', h('div', { class: 'inline' }, button('Fit to Scene', () => this.editor.fitGIToScene(), 'small', 'focus'), button('Recapture', () => this.editor.runtime.gi.invalidate(), 'small'))),
            error,
            h('div', { class: 'muted small pad', text: 'Surfaces more than one probe spacing outside the grid get no indirect light, so keep the grid around everything that should be lit.' }),
        );
        return section('gi', 'Global Illumination', 'sun', rows, [stageChip('light')]);
    }
}
