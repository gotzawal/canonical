import type { Editor } from '../editor';
import type { EnvironmentDoc, SkyType } from '../core/types';
import { clear, h } from './dom';
import { CheckboxField, ColorField, EditHooks, NumberField, SelectField, SliderField, TextField, row, section } from './widgets';

/** Scene-wide settings: sky, exposure, post effects, and editor preferences. */
export class ScenePanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private syncs: (() => void)[] = [];
    private sky: SkyType | null = null;
    private open = 0;
    private fov: SliderField | null = null;

    constructor(private editor: Editor) {
        this.body = h('div', { class: 'panel-body' });
        this.el = h('div', { class: 'panel scene-panel' }, this.body);
        editor.store.on('change', () => {
            if (editor.store.doc.environment.sky !== this.sky) this.render();
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
}
