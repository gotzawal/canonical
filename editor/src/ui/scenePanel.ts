import type { Editor } from '../editor';
import { clampGIGrid } from '../core/giLimits';
import type { EnvironmentDoc, SkyType, Vec3 } from '../core/types';
import { clear, h } from './dom';
import {
    CheckboxField, ColorField, EditHooks, NumberField, SelectField, SliderField, TextField, Vec3Field, button, row, section,
} from './widgets';

/** Scene-wide settings: sky, exposure, post effects, and editor preferences. */
export class ScenePanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private syncs: (() => void)[] = [];
    private sky: SkyType | null = null;
    private giOn: boolean | null = null;
    private open = 0;
    private fov: SliderField | null = null;

    constructor(private editor: Editor) {
        this.body = h('div', { class: 'panel-body' });
        this.el = h('div', { class: 'panel scene-panel' }, this.body);
        editor.store.on('change', () => {
            const env = editor.store.doc.environment;
            if (env.sky !== this.sky || env.gi.enable !== this.giOn) this.render();
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
        const write = (v: T) => store.update((doc) => apply(doc.environment, v), { env: true });
        return {
            begin: () => {
                this.open++;
                store.begin(label);
            },
            input: write,
            end: () => {
                if (this.open <= 0) return;
                this.open--;
                store.end();
            },
            commit: (v) => {
                store.begin(label);
                try {
                    write(v);
                } finally {
                    store.end();
                }
            },
        };
    }

    private render() {
        while (this.open > 0) {
            this.open--;
            this.editor.store.end();
        }
        clear(this.body);
        this.syncs = [];
        const env = this.env;
        this.sky = env.sky;
        this.giOn = env.gi.enable;
        const store = this.editor.store;
        const watch = (fn: () => void) => this.syncs.push(fn);

        // Scene
        const name = new TextField(store.doc.name, (v) => store.commit('Rename Scene', (doc) => (doc.name = v.trim() || 'Untitled Scene'), { env: true }));
        watch(() => name.set(store.doc.name));
        this.body.append(section('scene', 'Scene', 'layers', [row('Name', name.el)]));

        // Sky
        const skyRows: HTMLElement[] = [];
        const skyType = new SelectField<SkyType>(
            [
                { value: 'atmospheric', label: 'Atmospheric' },
                { value: 'color', label: 'Solid Color' },
            ],
            env.sky,
            (v) => this.hooks<SkyType>('Sky Type', (e, t) => (e.sky = t)).commit!(v),
        );
        skyRows.push(row('Type', skyType.el));
        if (env.sky === 'atmospheric') {
            const sunX = new SliderField({ value: env.sunX, min: 0, max: 1, step: 0.005, precision: 3, ...this.hooks<number>('Sun Direction', (e, v) => (e.sunX = v)) });
            const sunY = new SliderField({ value: env.sunY, min: 0, max: 1, step: 0.005, precision: 3, ...this.hooks<number>('Sun Height', (e, v) => (e.sunY = v)) });
            skyRows.push(row('Sun Direction', sunX.el), row('Sun Height', sunY.el));
            watch(() => {
                sunX.set(this.env.sunX);
                sunY.set(this.env.sunY);
            });
        } else {
            const color = new ColorField({ value: env.skyColor, ...this.hooks<string>('Sky Color', (e, v) => (e.skyColor = v)) });
            skyRows.push(row('Color', color.el));
            watch(() => color.set(this.env.skyColor));
        }
        const skyExposure = new SliderField({ value: env.skyExposure, min: 0, max: 4, step: 0.01, ...this.hooks<number>('Sky Exposure', (e, v) => (e.skyExposure = v)) });
        skyRows.push(row('Sky Exposure', skyExposure.el));
        watch(() => {
            skyType.set(this.env.sky);
            skyExposure.set(this.env.skyExposure);
        });
        this.body.append(section('sky', 'Environment', 'sun', skyRows));

        // Camera & tone mapping
        const exposure = new SliderField({ value: env.exposure, min: 0, max: 4, step: 0.01, ...this.hooks<number>('Exposure', (e, v) => (e.exposure = v)) });
        const fov = (this.fov = new SliderField({
            value: store.camera.fov,
            min: 15,
            max: 110,
            step: 1,
            precision: 0,
            input: (v) => store.setCamera({ ...store.camera, fov: v }),
            commit: (v) => store.setCamera({ ...store.camera, fov: v }),
        }));
        watch(() => exposure.set(this.env.exposure));
        this.body.append(section('camera', 'Camera', 'focus', [row('Exposure', exposure.el), row('Field of View', fov.el)]));

        // Post processing
        const fxaa = new CheckboxField(env.fxaa, (v) => this.hooks<boolean>('Anti-aliasing', (e, b) => (e.fxaa = b)).commit!(v));
        const bloom = new CheckboxField(env.bloom.enable, (v) => this.hooks<boolean>('Bloom', (e, b) => (e.bloom.enable = b)).commit!(v));
        const bloomI = new SliderField({ value: env.bloom.intensity, min: 0, max: 3, step: 0.01, ...this.hooks<number>('Bloom Intensity', (e, v) => (e.bloom.intensity = v)) });
        const bloomT = new SliderField({ value: env.bloom.threshold, min: 0, max: 4, step: 0.01, ...this.hooks<number>('Bloom Threshold', (e, v) => (e.bloom.threshold = v)) });
        const ao = new CheckboxField(env.ao.enable, (v) => this.hooks<boolean>('Ambient Occlusion', (e, b) => (e.ao.enable = b)).commit!(v));
        const aoS = new SliderField({ value: env.ao.strength, min: 0.01, max: 1, step: 0.01, ...this.hooks<number>('AO Strength', (e, v) => (e.ao.strength = v)) });
        const aoD = new SliderField({ value: env.ao.distance, min: 0.1, max: 10, step: 0.05, ...this.hooks<number>('AO Distance', (e, v) => (e.ao.distance = v)) });
        const fog = new CheckboxField(env.fog.enable, (v) => this.hooks<boolean>('Fog', (e, b) => (e.fog.enable = b)).commit!(v));
        const fogC = new ColorField({ value: env.fog.color, ...this.hooks<string>('Fog Color', (e, v) => (e.fog.color = v)) });
        const fogN = new NumberField({ value: env.fog.near, step: 0.1, min: 0, precision: 2, ...this.hooks<number>('Fog Start', (e, v) => (e.fog.near = v)) });
        const fogF = new NumberField({ value: env.fog.far, step: 0.5, min: 0.1, precision: 2, ...this.hooks<number>('Fog End', (e, v) => (e.fog.far = v)) });
        const fogI = new SliderField({ value: env.fog.intensity, min: 0, max: 1, step: 0.01, ...this.hooks<number>('Fog Amount', (e, v) => (e.fog.intensity = v)) });
        watch(() => {
            const e = this.env;
            fxaa.set(e.fxaa);
            bloom.set(e.bloom.enable);
            bloomI.set(e.bloom.intensity);
            bloomT.set(e.bloom.threshold);
            ao.set(e.ao.enable);
            aoS.set(e.ao.strength);
            aoD.set(e.ao.distance);
            fog.set(e.fog.enable);
            fogC.set(e.fog.color);
            fogN.set(e.fog.near);
            fogF.set(e.fog.far);
            fogI.set(e.fog.intensity);
        });
        this.body.append(
            section('post', 'Post Processing', 'sliders', [
                row('Anti-aliasing', fxaa.el, 'FXAA'),
                h('div', { class: 'group-label', text: 'Bloom' }),
                row('Enabled', bloom.el),
                row('Intensity', bloomI.el),
                row('Threshold', bloomT.el),
                h('div', { class: 'group-label', text: 'Ambient Occlusion' }),
                row('Enabled', ao.el),
                row('Strength', aoS.el),
                row('Distance', aoD.el),
                h('div', { class: 'group-label', text: 'Fog' }),
                row('Enabled', fog.el),
                row('Color', fogC.el),
                row('Start', fogN.el),
                row('End', fogF.el),
                row('Amount', fogI.el),
            ]),
        );

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
        const gi = this.env.gi;
        const enable = new CheckboxField(gi.enable, (v) => this.hooks<boolean>(v ? 'Enable GI' : 'Disable GI', (e, b) => (e.gi.enable = b)).commit!(v));
        const rows: HTMLElement[] = [row('Enabled', enable.el, 'Dynamic diffuse global illumination (DDGI)')];
        watch(() => enable.set(this.env.gi.enable));
        if (!gi.enable) {
            rows.push(h('div', { class: 'muted small pad', text: 'Light bounces between surfaces through a grid of light probes, so colored walls tint what is next to them and shaded areas get indirect light. Works in the viewport, in Play mode and in builds.' }));
            return section('gi', 'Global Illumination', 'sun', rows);
        }
        const center = new Vec3Field({ value: gi.center, step: 0.05, precision: 2, ...this.hooks<Vec3>('GI Center', (e, v) => (e.gi.center = v)) });
        const counts = new Vec3Field({
            value: gi.counts,
            step: 0.05,
            precision: 0,
            ...this.hooks<Vec3>('GI Probes', (e, v) => (e.gi.counts = clampGIGrid(v))),
        });
        const spacing = new NumberField({ value: gi.spacing, step: 0.01, min: 0.1, max: 100, precision: 2, ...this.hooks<number>('GI Spacing', (e, v) => (e.gi.spacing = v)) });
        const intensity = new SliderField({ value: gi.intensity, min: 0, max: 4, step: 0.01, ...this.hooks<number>('GI Intensity', (e, v) => (e.gi.intensity = v)) });
        const bounce = new SliderField({ value: gi.bounce, min: 0, max: 1, step: 0.01, ...this.hooks<number>('GI Bounce', (e, v) => (e.gi.bounce = v)) });
        const realtime = new CheckboxField(gi.realtime, (v) => this.hooks<boolean>('GI Realtime', (e, b) => (e.gi.realtime = b)).commit!(v), 'Update continuously');
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
            const g = this.env.gi;
            center.set(g.center);
            counts.set(g.counts);
            spacing.set(g.spacing);
            intensity.set(g.intensity);
            bounce.set(g.bounce);
            realtime.set(g.realtime);
            probes.set(store.prefs.giProbes);
            refresh();
        });
        rows.push(
            row('Center', center.el, 'Center of the probe grid'),
            row('Probes', counts.el, 'Probes along x, y and z (at most 16 per axis and 512 in all)'),
            row('Spacing', spacing.el, 'Distance between probes'),
            row('', info),
            row('Intensity', intensity.el, 'Strength of the indirect light'),
            row('Bounce', bounce.el, 'How much light keeps bouncing between surfaces'),
            row('Realtime', realtime.el, 'Capture the probes every frame, for moving objects and lights. Otherwise they are captured again after every change.'),
            row('Show Probes', probes.el, 'Draw a sphere per probe with the light it captured'),
            row('', h('div', { class: 'inline' }, button('Fit to Scene', () => this.editor.fitGIToScene(), 'small', 'focus'), button('Recapture', () => this.editor.runtime.gi.invalidate(), 'small'))),
            error,
            h('div', { class: 'muted small pad', text: 'Surfaces more than one probe spacing outside the grid get no indirect light, so keep the grid around everything that should be lit.' }),
        );
        return section('gi', 'Global Illumination', 'sun', rows);
    }
}
