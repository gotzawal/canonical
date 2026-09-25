import type { Editor } from '../editor';
import { formatBytes } from '../core/assets';
import { defaultGeometry, defaultLight, defaultMaterial } from '../core/defaults';
import type { GeometryType, LightType, NodeDoc, Vec3 } from '../core/types';
import { clear, h } from './dom';
import { icon, nodeIcon } from './icons';
import { MenuItem, showMenu } from './overlays';
import {
    CheckboxField, ColorField, EditHooks, NumberField, SelectField, SliderField, TextField, Vec3Field, button,
    iconButton, row, section,
} from './widgets';

const GEOMETRY_OPTIONS: { value: GeometryType; label: string }[] = [
    { value: 'box', label: 'Box' },
    { value: 'sphere', label: 'Sphere' },
    { value: 'plane', label: 'Plane' },
    { value: 'cylinder', label: 'Cylinder' },
    { value: 'torus', label: 'Torus' },
];

const LIGHT_OPTIONS: { value: LightType; label: string }[] = [
    { value: 'directional', label: 'Directional' },
    { value: 'point', label: 'Point' },
    { value: 'spot', label: 'Spot' },
];

type Filter = (n: NodeDoc) => boolean;

/** Property editor for the selected object(s). Edits apply to every selected object that has the property. */
export class InspectorPanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private syncs: (() => void)[] = [];
    private shape = '';
    /** Continuous edits begun by widgets that have not ended yet. */
    private open = 0;

    constructor(private editor: Editor, private showScene: () => void) {
        this.body = h('div', { class: 'panel-body inspector-body' });
        this.el = h('div', { class: 'panel inspector' }, this.body);
        const store = editor.store;
        store.on('selection', () => this.render());
        store.on('change', () => {
            if (this.shapeKey() !== this.shape) this.render();
            else this.refresh();
        });
        editor.sync.on('model', (id) => {
            if (store.selection.includes(id)) this.render();
        });
        this.render();
    }

    private get store() {
        return this.editor.store;
    }

    private shapeKey(): string {
        const n = this.store.primary;
        if (!n) return 'none';
        return [
            n.id,
            this.store.selection.length,
            n.mesh ? n.mesh.geometry.type + ':' + n.mesh.material.type : '-',
            n.light ? n.light.type : '-',
            n.model ? n.model.asset + ':' + (this.editor.sync.modelState(n.id)?.status ?? '') : '-',
            this.store.doc.assets.length,
        ].join('|');
    }

    private refresh() {
        for (const s of this.syncs) s();
    }

    render() {
        // A widget being torn down mid-drag must not leave its transaction open.
        while (this.open > 0) {
            this.open--;
            this.store.end();
        }
        this.shape = this.shapeKey();
        this.syncs = [];
        clear(this.body);
        const node = this.store.primary;
        if (!node) {
            this.body.append(
                h(
                    'div',
                    { class: 'inspector-empty' },
                    icon('cursor', 28),
                    h('p', { text: 'Select an object in the viewport or the hierarchy to edit it.' }),
                    button('Scene settings', () => this.showScene(), 'subtle', 'sliders'),
                ),
            );
            return;
        }
        this.body.append(this.header(node));
        this.body.append(this.transformSection());
        if (node.mesh) {
            this.body.append(this.meshSection());
            this.body.append(this.materialSection());
        }
        if (node.light) this.body.append(this.lightSection());
        if (node.model) this.body.append(this.modelSection(node));
        this.body.append(this.addComponent(node));
    }

    // -------------------------------------------------------------- binding

    /** Edit hooks that write `apply` to every selected node passing `filter`. */
    private hooks<T>(label: string, filter: Filter, apply: (n: NodeDoc, v: T) => void): EditHooks<T> {
        const store = this.store;
        const write = (v: T) => {
            const ids = store.selection.filter((id) => {
                const n = store.node(id);
                return n && filter(n);
            });
            store.update((doc) => {
                for (const n of doc.nodes) if (ids.includes(n.id)) apply(n, v);
            }, { nodes: ids });
        };
        return {
            begin: () => {
                this.open++;
                store.begin(label);
            },
            input: (v) => write(v),
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

    private watch(fn: () => void) {
        this.syncs.push(() => {
            if (this.store.primary) fn();
        });
    }

    private get node(): NodeDoc {
        return this.store.primary!;
    }

    // -------------------------------------------------------------- header

    private header(node: NodeDoc): HTMLElement {
        const count = this.store.selection.length;
        const name = new TextField(node.name, (v) => {
            if (v.trim()) this.editor.rename(node.id, v);
        });
        name.el.classList.add('name-input');
        const visible = new CheckboxField(node.visible, (v) => {
            const ids = this.store.selection;
            this.store.commit(v ? 'Show' : 'Hide', (doc) => {
                for (const n of doc.nodes) if (ids.includes(n.id)) n.visible = v;
            }, { nodes: ids });
        });
        visible.el.title = 'Visible';
        this.watch(() => {
            name.set(this.node.name);
            visible.set(this.node.visible);
        });
        return h(
            'div',
            { class: 'inspector-header' },
            h('div', { class: 'inspector-title' }, h('span', { class: 'tree-icon ' + nodeIcon(node) }, icon(nodeIcon(node), 18)), name.el, visible.el),
            count > 1 ? h('div', { class: 'multi-note', text: `${count} objects selected. Changes apply to all of them.` }) : null,
        );
    }

    // ------------------------------------------------------------ transform

    private transformSection(): HTMLElement {
        const all: Filter = () => true;
        const pos = new Vec3Field({
            value: this.node.position,
            step: 0.01,
            precision: 3,
            ...this.hooks<Vec3>('Move', all, (n, v) => (n.position = v)),
        });
        const rot = new Vec3Field({
            value: this.node.rotation,
            step: 0.5,
            precision: 2,
            ...this.hooks<Vec3>('Rotate', all, (n, v) => (n.rotation = v)),
        });
        const scl = new Vec3Field({
            value: this.node.scale,
            step: 0.01,
            precision: 3,
            ...this.hooks<Vec3>('Scale', all, (n, v) => (n.scale = v)),
        });
        this.watch(() => {
            pos.set(this.node.position);
            rot.set(this.node.rotation);
            scl.set(this.node.scale);
        });
        const reset = iconButton('dots', 'Transform options', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu([
                { label: 'Reset Position', action: () => this.editor.resetTransform('position') },
                { label: 'Reset Rotation', action: () => this.editor.resetTransform('rotation') },
                { label: 'Reset Scale', action: () => this.editor.resetTransform('scale') },
                { separator: true },
                { label: 'Reset All', action: () => this.editor.resetTransform('all') },
                { label: 'Drop to Ground', action: () => this.editor.dropToGround() },
            ], r.left - 120, r.bottom + 4);
        });
        return section('transform', 'Transform', 'move', [row('Position', pos.el), row('Rotation', rot.el), row('Scale', scl.el)], [reset]);
    }

    // ----------------------------------------------------------------- mesh

    private meshSection(): HTMLElement {
        const has: Filter = (n) => !!n.mesh;
        const g = this.node.mesh!.geometry;
        const rows: HTMLElement[] = [];
        const type = new SelectField(GEOMETRY_OPTIONS, g.type, (v) => {
            this.hooks<GeometryType>('Change Geometry', has, (n, t) => {
                if (n.mesh!.geometry.type !== t) n.mesh!.geometry = defaultGeometry(t);
            }).commit!(v);
        });
        rows.push(row('Shape', type.el));

        const param = (label: string, key: string, step: number, min: number, int = false) => {
            const field = new NumberField({
                value: (this.node.mesh!.geometry as any)[key],
                step,
                min,
                precision: int ? 0 : 3,
                ...this.hooks<number>('Edit ' + label, (n) => n.mesh?.geometry.type === g.type, (n, v) => {
                    (n.mesh!.geometry as any)[key] = int ? Math.round(v) : v;
                }),
            });
            this.watch(() => {
                const cur = this.node.mesh?.geometry as any;
                if (cur && key in cur) field.set(cur[key]);
            });
            rows.push(row(label, field.el));
        };
        switch (g.type) {
            case 'box':
                param('Width', 'width', 0.01, 0.001);
                param('Height', 'height', 0.01, 0.001);
                param('Depth', 'depth', 0.01, 0.001);
                break;
            case 'sphere':
                param('Radius', 'radius', 0.01, 0.001);
                param('Segments', 'segments', 0.25, 3, true);
                break;
            case 'plane':
                param('Width', 'width', 0.05, 0.001);
                param('Length', 'height', 0.05, 0.001);
                break;
            case 'cylinder':
                param('Top Radius', 'radiusTop', 0.01, 0);
                param('Bottom Radius', 'radiusBottom', 0.01, 0);
                param('Height', 'height', 0.01, 0.001);
                param('Segments', 'segments', 0.25, 3, true);
                break;
            case 'torus':
                param('Radius', 'radius', 0.01, 0.001);
                param('Tube', 'tube', 0.005, 0.001);
                param('Segments', 'segments', 0.25, 3, true);
                break;
        }
        const cast = new CheckboxField(this.node.mesh!.castShadow, (v) => this.hooks<boolean>('Cast Shadow', has, (n, b) => (n.mesh!.castShadow = b)).commit!(v), 'Cast');
        const receive = new CheckboxField(this.node.mesh!.receiveShadow, (v) => this.hooks<boolean>('Receive Shadow', has, (n, b) => (n.mesh!.receiveShadow = b)).commit!(v), 'Receive');
        this.watch(() => {
            if (!this.node.mesh) return;
            type.set(this.node.mesh.geometry.type);
            cast.set(this.node.mesh.castShadow);
            receive.set(this.node.mesh.receiveShadow);
        });
        rows.push(row('Shadows', h('div', { class: 'inline' }, cast.el, receive.el)));
        const remove = iconButton('trash', 'Remove mesh', () => {
            this.hooks<null>('Remove Mesh', has, (n) => delete n.mesh).commit!(null);
        });
        return section('mesh', 'Mesh', 'cube', rows, [remove]);
    }

    private materialSection(): HTMLElement {
        const has: Filter = (n) => !!n.mesh;
        const m = this.node.mesh!.material;
        const lit = m.type === 'lit';
        const rows: HTMLElement[] = [];
        const type = new SelectField(
            [
                { value: 'lit', label: 'Lit (PBR)' },
                { value: 'unlit', label: 'Unlit' },
            ],
            m.type,
            (v) => this.hooks<'lit' | 'unlit'>('Material Type', has, (n, t) => (n.mesh!.material.type = t)).commit!(v),
        );
        rows.push(row('Type', type.el));

        const color = new ColorField({ value: m.color, ...this.hooks<string>('Color', has, (n, v) => (n.mesh!.material.color = v)) });
        rows.push(row('Color', color.el));
        const opacity = new SliderField({ value: m.opacity, min: 0, max: 1, step: 0.01, ...this.hooks<number>('Opacity', has, (n, v) => (n.mesh!.material.opacity = v)) });
        rows.push(row('Opacity', opacity.el));

        let metallic: SliderField | null = null, roughness: SliderField | null = null, emissive: ColorField | null = null, emissiveI: NumberField | null = null;
        if (lit) {
            metallic = new SliderField({ value: m.metallic, min: 0, max: 1, step: 0.01, ...this.hooks<number>('Metallic', has, (n, v) => (n.mesh!.material.metallic = v)) });
            roughness = new SliderField({ value: m.roughness, min: 0, max: 1, step: 0.01, ...this.hooks<number>('Roughness', has, (n, v) => (n.mesh!.material.roughness = v)) });
            emissive = new ColorField({ value: m.emissive, ...this.hooks<string>('Emissive', has, (n, v) => (n.mesh!.material.emissive = v)) });
            emissiveI = new NumberField({ value: m.emissiveIntensity, step: 0.05, min: 0, precision: 2, ...this.hooks<number>('Emissive Intensity', has, (n, v) => (n.mesh!.material.emissiveIntensity = v)) });
            rows.push(row('Metallic', metallic.el), row('Roughness', roughness.el), row('Emissive', emissive.el), row('Emission', emissiveI.el, 'Emissive intensity'));
        }
        const doubleSide = new CheckboxField(m.doubleSide, (v) => this.hooks<boolean>('Double Sided', has, (n, b) => (n.mesh!.material.doubleSide = b)).commit!(v));
        rows.push(row('Double Sided', doubleSide.el));

        const textures = this.store.doc.assets.filter((a) => a.kind === 'texture');
        const map = new SelectField<string>(
            [{ value: '', label: 'None' }, ...textures.map((t) => ({ value: t.id, label: t.name }))],
            m.map ?? '',
            (v) => this.editor.applyTexture(v || null),
        );
        rows.push(row('Texture', h('div', { class: 'inline' }, map.el, iconButton('upload', 'Import image', () => this.editor.importTextureDialog()))));

        this.watch(() => {
            const mat = this.node.mesh?.material;
            if (!mat) return;
            type.set(mat.type);
            color.set(mat.color);
            opacity.set(mat.opacity);
            metallic?.set(mat.metallic);
            roughness?.set(mat.roughness);
            emissive?.set(mat.emissive);
            emissiveI?.set(mat.emissiveIntensity);
            doubleSide.set(mat.doubleSide);
            map.set(mat.map ?? '');
        });
        const reset = iconButton('undo', 'Reset material', () => {
            this.hooks<null>('Reset Material', has, (n) => (n.mesh!.material = defaultMaterial())).commit!(null);
        });
        return section('material', 'Material', 'sphere', rows, [reset]);
    }

    // ---------------------------------------------------------------- light

    private lightSection(): HTMLElement {
        const has: Filter = (n) => !!n.light;
        const l = this.node.light!;
        const rows: HTMLElement[] = [];
        const type = new SelectField(LIGHT_OPTIONS, l.type, (v) => this.hooks<LightType>('Light Type', has, (n, t) => {
            if (n.light!.type !== t) n.light = { ...defaultLight(t), color: n.light!.color };
        }).commit!(v));
        rows.push(row('Type', type.el));
        const color = new ColorField({ value: l.color, ...this.hooks<string>('Light Color', has, (n, v) => (n.light!.color = v)) });
        const intensity = new NumberField({ value: l.intensity, step: 0.05, min: 0, precision: 2, ...this.hooks<number>('Intensity', has, (n, v) => (n.light!.intensity = v)) });
        const shadow = new CheckboxField(l.castShadow, (v) => this.hooks<boolean>('Cast Shadow', has, (n, b) => (n.light!.castShadow = b)).commit!(v));
        rows.push(row('Color', color.el), row('Intensity', intensity.el), row('Cast Shadows', shadow.el));
        let range: NumberField | null = null, radius: NumberField | null = null, angle: SliderField | null = null, inner: SliderField | null = null;
        if (l.type !== 'directional') {
            const same: Filter = (n) => n.light?.type === l.type;
            range = new NumberField({ value: l.range, step: 0.05, min: 0.01, precision: 2, ...this.hooks<number>('Range', same, (n, v) => (n.light!.range = v)) });
            radius = new NumberField({ value: l.radius, step: 0.005, min: 0, precision: 3, ...this.hooks<number>('Radius', same, (n, v) => (n.light!.radius = v)) });
            rows.push(row('Range', range.el), row('Radius', radius.el, 'Size of the light source'));
            if (l.type === 'spot') {
                angle = new SliderField({ value: l.outerAngle, min: 1, max: 179, step: 1, precision: 1, ...this.hooks<number>('Cone Angle', same, (n, v) => (n.light!.outerAngle = v)) });
                inner = new SliderField({ value: l.innerAngle, min: 0, max: 100, step: 1, precision: 0, ...this.hooks<number>('Inner Cone', same, (n, v) => (n.light!.innerAngle = v)) });
                rows.push(row('Cone Angle', angle.el), row('Inner Cone %', inner.el, 'Inner cone as a percentage of the cone angle'));
            }
        }
        this.watch(() => {
            const cur = this.node.light;
            if (!cur) return;
            type.set(cur.type);
            color.set(cur.color);
            intensity.set(cur.intensity);
            shadow.set(cur.castShadow);
            range?.set(cur.range);
            radius?.set(cur.radius);
            angle?.set(cur.outerAngle);
            inner?.set(cur.innerAngle);
        });
        const remove = iconButton('trash', 'Remove light', () => this.hooks<null>('Remove Light', has, (n) => delete n.light).commit!(null));
        return section('light', 'Light', l.type === 'directional' ? 'sun' : l.type === 'point' ? 'bulb' : 'spot', rows, [remove]);
    }

    // ---------------------------------------------------------------- model

    private modelSection(node: NodeDoc): HTMLElement {
        const asset = this.store.doc.assets.find((a) => a.id === node.model!.asset);
        const state = this.editor.sync.modelState(node.id);
        const status = state?.status === 'ready' ? 'Loaded' : state?.status === 'error' ? `Failed: ${state.error}` : 'Loading...';
        return section('model', 'Model', 'model', [
            row('File', h('div', { class: 'readonly', text: asset ? asset.name : 'Missing asset' })),
            row('Size', h('div', { class: 'readonly', text: asset ? formatBytes(asset.size) : '-' })),
            row('Status', h('div', { class: 'readonly' + (state?.status === 'error' ? ' error-text' : ''), text: status })),
        ]);
    }

    private addComponent(node: NodeDoc): HTMLElement {
        const items: MenuItem[] = [];
        if (!node.mesh && !node.model) {
            items.push({
                label: 'Mesh',
                icon: 'cube',
                action: () => this.hooks<null>('Add Mesh', (n) => !n.mesh && !n.model, (n) => {
                    n.mesh = { geometry: defaultGeometry('box'), material: defaultMaterial(), castShadow: true, receiveShadow: true };
                }).commit!(null),
            });
        }
        if (!node.light) {
            for (const t of LIGHT_OPTIONS) {
                items.push({
                    label: t.label + ' Light',
                    icon: t.value === 'directional' ? 'sun' : t.value === 'point' ? 'bulb' : 'spot',
                    action: () => this.hooks<null>('Add Light', (n) => !n.light, (n) => (n.light = defaultLight(t.value))).commit!(null),
                });
            }
        }
        const btn = button('Add Component', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(items, r.left, r.bottom + 4);
        }, 'add-component', 'plus');
        if (!items.length) btn.disabled = true;
        return h('div', { class: 'add-component-row' }, btn);
    }
}
