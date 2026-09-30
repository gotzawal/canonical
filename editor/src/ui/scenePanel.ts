import type { z } from 'zod';
import type { Editor } from '../editor';
import { onChanges, touches } from './batch';
import { Environment } from '../core/model';
import { inner } from '../core/schema';
import type { EnvironmentDoc, SkyType } from '../core/types';
import { clear, h } from './dom';
import { schemaRows } from './schemaFields';
import { CheckboxField, EditHooks, FieldSteps, NumberField, SliderField, TextField, button, row, section } from './widgets';

type Group = 'bloom' | 'ao' | 'fog' | 'gi' | 'shadow' | 'godRays' | 'volumetricFog' | 'atmosphere';

/** Scene-wide settings: sky, exposure, post effects, and editor preferences. */
export class ScenePanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private syncs: (() => void)[] = [];
    private sky: SkyType | null = null;
    private giOn: boolean | null = null;
    private fogMode: string | null = null;
    private steps: FieldSteps;
    private fov: SliderField | null = null;

    constructor(private editor: Editor) {
        this.steps = new FieldSteps(editor.store);
        this.body = h('div', { class: 'panel-body' });
        this.el = h('div', { class: 'panel scene-panel' }, this.body);
        onChanges(editor.store, (hint) => {
            if (!touches(hint, 'env')) return;
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

    private get env(): EnvironmentDoc {
        return this.editor.store.doc.environment;
    }

    private hooks<T>(label: string, apply: (env: EnvironmentDoc, v: T) => void): EditHooks<T> {
        const store = this.editor.store;
        return this.steps.hooks(label, (v: T) => store.update((doc) => apply(doc.environment, v), { env: true }));
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

        // Sky
        const sunSky = env.sky !== 'color';
        this.body.append(
            section('sky', 'Environment', 'sun', [
                ...this.rows(['sky', ...(sunSky ? ['sunX', 'sunY'] : ['skyColor']), 'skyExposure']),
                // The sun disc and the air, and the physical sky's clouds.
                ...(sunSky ? this.rows(['sunSize', 'sunBrightness', 'showSun', 'altitude', ...(env.sky === 'physical' ? ['clouds'] : [])], 'atmosphere') : []),
            ]),
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
        this.body.append(section('camera', 'Camera', 'focus', [...this.rows(['exposure']), row('Field of View', fov.el)]));

        // Post processing
        const label = (text: string) => h('div', { class: 'group-label', text });
        this.body.append(
            section('post', 'Post Processing', 'sliders', [
                ...this.rows(['fxaa']),
                label('Bloom'),
                ...this.rows(['enable', 'intensity', 'threshold'], 'bloom'),
                label('Ambient Occlusion'),
                ...this.rows(['enable', 'strength', 'distance'], 'ao'),
                label('Fog'),
                ...this.rows(['enable', 'mode', 'color', 'near', ...(env.fog.mode === 'linear' ? ['far'] : ['density']), ...(env.fog.mode === 'height' ? ['height', 'heightFalloff'] : []), 'intensity', 'sky', 'sunScatter', 'sunFocus'], 'fog'),
                label('Volumetric Fog'),
                ...this.rows(['enable', 'density', 'scattering', 'anisotropy', 'distance', 'ambient'], 'volumetricFog'),
                label('God Rays'),
                ...this.rows(['enable', 'intensity', 'focus'], 'godRays'),
            ]),
        );
        this.body.append(section('shadows', 'Shadows', 'sun', this.rows(['range', 'softness', 'follow'], 'shadow')));

        this.body.append(this.giSection(watch));

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
            return section('gi', 'Global Illumination', 'sun', rows);
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
            ...this.rows(['intensity', 'bounce', 'realtime'], 'gi'),
            row('Show Probes', probes.el, 'Draw a sphere per probe with the light it captured'),
            row('', h('div', { class: 'inline' }, button('Fit to Scene', () => this.editor.fitGIToScene(), 'small', 'focus'), button('Recapture', () => this.editor.runtime.gi.invalidate(), 'small'))),
            error,
            h('div', { class: 'muted small pad', text: 'Surfaces more than one probe spacing outside the grid get no indirect light, so keep the grid around everything that should be lit.' }),
        );
        return section('gi', 'Global Illumination', 'sun', rows);
    }
}
