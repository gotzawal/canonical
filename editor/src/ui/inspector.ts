import type { Editor } from '../editor';
import { formatBytes } from '../core/assets';
import { defaultCameraDoc, defaultGeometry, defaultLight, defaultMaterial } from '../core/defaults';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES } from '../core/templates';
import type {
    AlphaMode, AssetMeta, GeometryType, LightType, MaterialDoc, MaterialOverride, MaterialType, NodeDoc, ParamValue,
    PartOverride, ScriptRef, SlotShading, Vec3,
} from '../core/types';
import { MATERIAL_PRESETS } from '../core/materialPresets';
import { slotShading, type ModelInfo, type ModelPart, type ModelSlot } from '../engine/modelParts';
import { clear, h } from './dom';
import { icon, nodeIcon } from './icons';
import { MenuItem, showMenu } from './overlays';
import { scriptFieldRows, shaderParamRows } from './paramFields';
import {
    CheckboxField, ColorField, EditHooks, NumberField, SelectField, SliderField, TextField, Vec2Field, Vec3Field, button,
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

const MATERIAL_TYPES: { value: MaterialType; label: string; hint: string }[] = [
    { value: 'lit', label: 'Lit (PBR)', hint: 'Physically based: lights, shadows, reflections, clear coat, glass' },
    { value: 'unlit', label: 'Unlit', hint: 'Shows its color and texture as they are, ignoring lights' },
    { value: 'lambert', label: 'Lambert (Matte)', hint: 'Cheap matte shading from directional lights, no specular or shadows' },
    { value: 'shader', label: 'Custom Shader', hint: 'Renders with a WGSL material shader' },
];

const ALPHA_MODES: { value: AlphaMode; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'opaque', label: 'Opaque' },
    { value: 'mask', label: 'Mask (cut-out)' },
    { value: 'blend', label: 'Blend (transparent)' },
    { value: 'additive', label: 'Additive' },
    { value: 'multiply', label: 'Multiply' },
];

const FILE_ALPHA: Record<string, string> = { OPAQUE: 'opaque', MASK: 'cut-out', BLEND: 'blend' };

const SLOT_SHADING: { value: string; label: string }[] = [
    { value: 'model', label: 'Model (PBR)' },
    { value: 'unlit', label: 'Unlit' },
    { value: 'lambert', label: 'Lambert (Matte)' },
    { value: 'shader', label: 'Custom Shader' },
];

const MAX_PARTS = 150;

type Filter = (n: NodeDoc) => boolean;

/** Property editor for the selected object(s). Edits apply to every selected object that has the property. */
export class InspectorPanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private syncs: (() => void)[] = [];
    private shape = '';
    /** Continuous edits begun by widgets that have not ended yet. */
    private open = 0;
    private openSlots = new Set<string>();
    private openParts = new Set<string>();
    private partFilter = '';

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
        editor.shaders.on('status', () => {
            if (this.shapeKey() !== this.shape) this.render();
        });
        editor.compiler.on('compiled', () => {
            if (this.shapeKey() !== this.shape) this.render();
        });
        editor.on('focus-part', ({ node, path }) => {
            if (node !== store.primary?.id || !path) return;
            this.openParts.add(path);
            const slot = editor.sync.modelInfo(node)?.part(path)?.slot;
            if (slot) this.openSlots.add(slot);
            this.render();
            requestAnimationFrame(() => {
                this.body.querySelector('.part-row.focused')?.scrollIntoView({ block: 'nearest' });
            });
        });
        this.render();
    }

    private get store() {
        return this.editor.store;
    }

    private shapeKey(): string {
        const n = this.store.primary;
        if (!n) return 'none';
        const mat = n.mesh?.material;
        const shaderId = mat?.type === 'shader' ? mat.shader ?? '' : '';
        const info = n.model ? this.editor.sync.modelInfo(n.id) : null;
        return [
            n.id,
            this.store.selection.length,
            n.mesh ? n.mesh.geometry.type + ':' + mat!.type + ':' + (mat!.alphaMode ?? '') + ':' + shaderId + ':' + this.propsKey(shaderId) : '-',
            n.light ? n.light.type : '-',
            n.camera ? 'cam' : '-',
            n.model ? n.model.asset + ':' + (this.editor.sync.modelState(n.id)?.status ?? '') + ':' + (info ? info.parts.length : 0) : '-',
            n.model ? JSON.stringify(Object.keys(n.model.materials ?? {})) + JSON.stringify(Object.keys(n.model.parts ?? {})) : '',
            n.model ? Object.values(n.model.materials ?? {}).map((o) => (o.shading ?? '') + (o.alphaMode ?? '') + (o.shader ?? '') + this.propsKey(o.shader ?? '')).join(',') : '',
            (n.scripts ?? []).map((r) => r.script + ':' + this.scriptKey(r.script)).join(','),
            this.store.doc.assets.length,
            this.store.doc.scripts.map((s) => s.id + s.name).join(','),
            this.store.doc.shaders.map((s) => s.id + s.name + s.kind + s.lighting).join(','),
        ].join('|');
    }

    private propsKey(shaderId: string): string {
        if (!shaderId) return '';
        return this.editor.shaders.props(shaderId).map((p) => p.name + p.type).join(',') + ':' + this.editor.shaders.status(shaderId).state;
    }

    private scriptKey(id: string): string {
        const c = this.editor.compiler.get(id);
        if (!c) return 'missing';
        return (c.paused ? 'paused' : c.error ? 'err' : 'ok') + c.fields.map((f) => f.name + f.type).join(',') + (c.fieldError ? 'fe' : '');
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
        const scroll = this.body.scrollTop;
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
        if (node.camera) this.body.append(this.cameraSection());
        if (node.model) this.body.append(...this.modelSections(node));
        (node.scripts ?? []).forEach((ref, i) => this.body.append(this.scriptSection(node, ref, i)));
        this.body.append(this.addComponent(node));
        this.body.scrollTop = scroll;
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
        const shaderDoc = m.type === 'shader' ? this.store.doc.shaders.find((s) => s.id === m.shader) : null;
        // Unlit and Lambert materials, and unlit shaders, ignore metallic, roughness and emission.
        const lit = m.type === 'lit' || (m.type === 'shader' && shaderDoc?.lighting !== 'unlit');
        const pbr = m.type === 'lit';
        const set = <K extends keyof MaterialDoc>(key: K, label: string) =>
            this.hooks<MaterialDoc[K]>(label, has, (n, v) => {
                (n.mesh!.material as any)[key] = v;
            });
        const rows: HTMLElement[] = [];
        const type = new SelectField<MaterialType>(MATERIAL_TYPES, m.type, (v) => {
            if (v === 'shader') {
                const first = this.store.doc.shaders.find((s) => s.kind === 'material');
                const sel = this.store.selection;
                if (!first) {
                    const created = this.editor.createShader({ template: 'lit' });
                    this.editor.assignShader(sel, created.id);
                } else this.editor.assignShader(sel, m.shader && this.store.doc.shaders.some((s) => s.id === m.shader) ? m.shader : first.id);
                return;
            }
            this.hooks<MaterialType>('Material Type', has, (n, t) => (n.mesh!.material.type = t)).commit!(v);
        });
        rows.push(row('Type', type.el, MATERIAL_TYPES.find((t) => t.value === m.type)?.hint));

        if (m.type === 'shader') rows.push(...this.shaderRows(m.shader ?? null));

        const color = new ColorField({ value: m.color, ...set('color', 'Color') });
        rows.push(row('Color', color.el));
        const opacity = new SliderField({ value: m.opacity, min: 0, max: 1, step: 0.01, ...set('opacity', 'Opacity') });
        rows.push(row('Opacity', opacity.el));
        const alpha = new SelectField<AlphaMode>(ALPHA_MODES, m.alphaMode ?? 'auto', (v) => set('alphaMode', 'Alpha Mode').commit!(v === 'auto' ? undefined : v));
        rows.push(row('Alpha', alpha.el, 'Auto blends when opacity is below 1; Mask cuts out pixels below the cutoff; Additive and Multiply are transparent blending modes'));
        let cutoff: SliderField | null = null;
        if (m.alphaMode === 'mask') {
            cutoff = new SliderField({ value: m.alphaCutoff ?? 0.5, min: 0, max: 1, step: 0.01, ...set('alphaCutoff', 'Alpha Cutoff') });
            rows.push(row('Cutoff', cutoff.el, 'Pixels with less alpha are cut out'));
        }

        let metallic: SliderField | null = null, roughness: SliderField | null = null, emissive: ColorField | null = null, emissiveI: NumberField | null = null;
        if (lit) {
            metallic = new SliderField({ value: m.metallic, min: 0, max: 1, step: 0.01, ...set('metallic', 'Metallic') });
            roughness = new SliderField({ value: m.roughness, min: 0, max: 1, step: 0.01, ...set('roughness', 'Roughness') });
            emissive = new ColorField({ value: m.emissive, ...set('emissive', 'Emissive') });
            emissiveI = new NumberField({ value: m.emissiveIntensity, step: 0.05, min: 0, precision: 2, ...set('emissiveIntensity', 'Emissive Intensity') });
            if (m.type !== 'lambert') rows.push(row('Metallic', metallic.el), row('Roughness', roughness.el));
            rows.push(row('Emissive', emissive.el), row('Emission', emissiveI.el, 'Emissive intensity'));
        }
        const doubleSide = new CheckboxField(m.doubleSide, (v) => this.hooks<boolean>('Double Sided', has, (n, b) => (n.mesh!.material.doubleSide = b)).commit!(v));
        rows.push(row('Double Sided', doubleSide.el));

        const textures = this.store.doc.assets.filter((a) => a.kind === 'texture');
        const map = this.textureSelect(m.map ?? null, textures, (v) => this.editor.applyTexture(v));
        rows.push(row('Texture', map.el, 'Base color map'));
        const tiling = new Vec2Field({ value: m.tiling ?? [1, 1], step: 0.01, precision: 3, ...set('tiling', 'Texture Tiling') });
        const offset = new Vec2Field({ value: m.offset ?? [0, 0], step: 0.005, precision: 3, ...set('offset', 'Texture Offset') });
        rows.push(row('Tiling', tiling.el, 'Texture repeat'), row('Offset', offset.el, 'Texture offset'));

        // PBR extras of the lit material.
        const extra: { set(md: MaterialDoc): void }[] = [];
        if (pbr) {
            rows.push(h('div', { class: 'group-label', text: 'Maps' }));
            const mapRow = (key: 'normalMap' | 'metalRoughMap' | 'aoMap' | 'emissiveMap', label: string, hint: string) => {
                const f = this.textureSelect((m[key] as string | null | undefined) ?? null, textures, (v) => set(key, label).commit!(v));
                extra.push({ set: (md) => f.set((md[key] as string | null | undefined) ?? null) });
                rows.push(row(label, f.el, hint));
            };
            mapRow('normalMap', 'Normal Map', 'Tangent space normal map');
            const normalScale = new SliderField({ value: m.normalScale ?? 1, min: 0, max: 2, step: 0.01, ...set('normalScale', 'Normal Strength') });
            extra.push({ set: (md) => normalScale.set(md.normalScale ?? 1) });
            rows.push(row('Strength', normalScale.el, 'Normal map strength'));
            mapRow('metalRoughMap', 'Metal / Rough', 'glTF metallic-roughness map: roughness in green, metallic in blue. Multiplies the sliders.');
            mapRow('aoMap', 'Occlusion', 'Ambient occlusion map (red channel)');
            mapRow('emissiveMap', 'Emission Map', 'Multiplied by the emissive color');

            rows.push(h('div', { class: 'group-label', text: 'Clear Coat' }));
            const coat = new SliderField({ value: m.clearcoat ?? 0, min: 0, max: 1, step: 0.01, ...set('clearcoat', 'Clear Coat') });
            const coatR = new SliderField({ value: m.clearcoatRoughness ?? 0, min: 0, max: 1, step: 0.01, ...set('clearcoatRoughness', 'Clear Coat Roughness') });
            extra.push({ set: (md) => { coat.set(md.clearcoat ?? 0); coatR.set(md.clearcoatRoughness ?? 0); } });
            rows.push(row('Coat', coat.el, 'Glossy varnish layer (car paint, lacquer)'), row('Coat Rough.', coatR.el, 'Roughness of the clear coat'));

            rows.push(h('div', { class: 'group-label', text: 'Transmission' }));
            const trans = new SliderField({ value: m.transmission ?? 0, min: 0, max: 1, step: 0.01, ...set('transmission', 'Transmission') });
            const ior = new SliderField({ value: m.ior ?? 1.5, min: 1, max: 2.5, step: 0.01, ...set('ior', 'IOR') });
            const thick = new NumberField({ value: m.thickness ?? 0, step: 0.01, min: 0, precision: 3, ...set('thickness', 'Thickness') });
            const attC = new ColorField({ value: m.attenuationColor ?? '#ffffff', ...set('attenuationColor', 'Attenuation Color') });
            const attD = new NumberField({ value: m.attenuationDistance ?? 0, step: 0.05, min: 0, precision: 2, ...set('attenuationDistance', 'Attenuation Distance') });
            extra.push({
                set: (md) => {
                    trans.set(md.transmission ?? 0);
                    ior.set(md.ior ?? 1.5);
                    thick.set(md.thickness ?? 0);
                    attC.set(md.attenuationColor ?? '#ffffff');
                    attD.set(md.attenuationDistance ?? 0);
                },
            });
            rows.push(
                row('Transmission', trans.el, 'Light passing through the surface: glass, water, gems'),
                row('IOR', ior.el, 'Index of refraction (glass 1.5, water 1.33, diamond 2.4)'),
                row('Thickness', thick.el, 'Thickness of the volume behind the surface'),
                row('Tint', attC.el, 'Color light turns into while it travels through the volume'),
                row('Tint Distance', attD.el, 'Distance at which light reaches the tint color; 0 means no tint'),
            );
        }

        if (m.type === 'shader' && m.shader) {
            const shaderId = m.shader;
            const props = this.editor.shaders.props(shaderId);
            if (props.length) {
                rows.push(h('div', { class: 'group-label', text: 'Shader Properties' }));
                const watchers: ((v: Record<string, ParamValue>) => void)[] = [];
                rows.push(
                    ...shaderParamRows(
                        props,
                        m.params ?? {},
                        (name, label) =>
                            this.hooks<ParamValue>(label, (n) => n.mesh?.material.shader === shaderId, (n, v) => {
                                n.mesh!.material.params = { ...(n.mesh!.material.params ?? {}), [name]: v };
                            }),
                        textures,
                        (fn) => watchers.push(fn),
                    ),
                );
                this.watch(() => {
                    const params = this.node.mesh?.material.params ?? {};
                    for (const w of watchers) w(params);
                });
            }
        }

        this.watch(() => {
            const mat = this.node.mesh?.material;
            if (!mat) return;
            type.set(mat.type);
            color.set(mat.color);
            opacity.set(mat.opacity);
            alpha.set(mat.alphaMode ?? 'auto');
            cutoff?.set(mat.alphaCutoff ?? 0.5);
            metallic?.set(mat.metallic);
            roughness?.set(mat.roughness);
            emissive?.set(mat.emissive);
            emissiveI?.set(mat.emissiveIntensity);
            doubleSide.set(mat.doubleSide);
            map.set(mat.map ?? null);
            tiling.set(mat.tiling ?? [1, 1]);
            offset.set(mat.offset ?? [0, 0]);
            for (const e of extra) e.set(mat);
        });
        const presets = iconButton('dots', 'Material presets', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                MATERIAL_PRESETS.map((p) => ({ label: p.label, action: () => this.editor.applyMaterialPreset(this.store.selection, p.id) })),
                r.left - 150,
                r.bottom + 4,
            );
        });
        const reset = iconButton('undo', 'Reset material', () => {
            this.hooks<null>('Reset Material', has, (n) => (n.mesh!.material = defaultMaterial())).commit!(null);
        });
        return section('material', 'Material', 'sphere', rows, [presets, reset]);
    }

    /** Texture asset picker with an import button; `null` means no texture. */
    private textureSelect(value: string | null, textures: AssetMeta[], onPick: (id: string | null) => void): { el: HTMLElement; set(v: string | null): void } {
        const select = new SelectField<string>([{ value: '', label: 'None' }, ...textures.map((t) => ({ value: t.id, label: t.name }))], value ?? '', (v) => onPick(v || null));
        const el = h('div', { class: 'inline' }, select.el, iconButton('upload', 'Import image', () => this.editor.importTextureDialog()));
        return { el, set: (v) => select.set(v ?? '') };
    }

    /** Shader picker with status and edit / new actions. */
    private shaderRows(current: string | null, onPick?: (id: string | null) => void): HTMLElement[] {
        const shaders = this.store.doc.shaders.filter((s) => s.kind === 'material');
        const pick = onPick ?? ((id: string | null) => this.editor.assignShader(this.store.selection, id));
        const select = new SelectField<string>(
            [...(onPick ? [{ value: '', label: 'None (file material)' }] : []), ...shaders.map((s) => ({ value: s.id, label: s.name }))],
            current ?? '',
            (v) => pick(v || null),
        );
        const edit = iconButton('code', 'Edit shader', () => current && this.editor.emit('open-code', { kind: 'shader', id: current }));
        edit.disabled = !current;
        const add = iconButton('plus', 'New shader', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                SHADER_TEMPLATES.filter((t) => t.kind === 'material').map((t) => ({
                    label: t.label,
                    action: () => {
                        const doc = this.editor.createShader({ template: t.id });
                        pick(doc.id);
                    },
                })),
                r.left - 140,
                r.bottom + 4,
            );
        });
        const rows = [row('Shader', h('div', { class: 'inline' }, select.el, edit, add))];
        if (current) {
            const st = this.editor.shaders.status(current);
            const valid = this.editor.shaders.isValid(current);
            let text = '';
            let cls = 'readonly';
            if (st.state === 'compiling') text = 'Compiling...';
            else if (st.state === 'error') {
                text = valid ? 'Has errors, using the last version that compiled' : 'Does not compile (shown magenta)';
                cls += ' error-text';
            } else if (valid) text = st.messages.length ? `Compiled with ${st.messages.length} warning(s)` : 'Compiled';
            if (text) {
                const status = h('div', { class: cls, text });
                if (st.state === 'error') {
                    status.appendChild(document.createTextNode(' '));
                    const fix = h('button', { class: 'link-btn', text: 'Open', attrs: { type: 'button' } });
                    fix.addEventListener('click', () => this.editor.emit('open-code', { kind: 'shader', id: current }));
                    status.appendChild(fix);
                }
                rows.push(row('Status', status));
            }
        }
        return rows;
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

    // --------------------------------------------------------------- camera

    private cameraSection(): HTMLElement {
        const has: Filter = (n) => !!n.camera;
        const c = this.node.camera!;
        const fov = new SliderField({ value: c.fov, min: 10, max: 120, step: 1, precision: 0, ...this.hooks<number>('Field of View', has, (n, v) => (n.camera!.fov = v)) });
        const near = new NumberField({ value: c.near, step: 0.01, min: 0.001, precision: 3, ...this.hooks<number>('Near Plane', has, (n, v) => (n.camera!.near = v)) });
        const far = new NumberField({ value: c.far, step: 1, min: 0.1, precision: 1, ...this.hooks<number>('Far Plane', has, (n, v) => (n.camera!.far = v)) });
        const main = new CheckboxField(c.main, (v) => {
            const id = this.node.id;
            this.store.commit('Main Camera', (doc) => {
                for (const n of doc.nodes) if (n.camera) n.camera.main = v ? n.id === id : n.id === id ? false : n.camera.main;
            });
        }, 'Used by Play');
        this.watch(() => {
            const cur = this.node.camera;
            if (!cur) return;
            fov.set(cur.fov);
            near.set(cur.near);
            far.set(cur.far);
            main.set(cur.main);
        });
        const actions = h(
            'div',
            { class: 'inline' },
            button('Align to View', () => this.editor.alignCameraToView(), 'small', 'focus'),
            button('Look Through', () => this.editor.viewThroughCamera(this.node.id), 'small', 'camera'),
        );
        const remove = iconButton('trash', 'Remove camera', () => this.hooks<null>('Remove Camera', has, (n) => delete n.camera).commit!(null));
        return section('camera', 'Camera', 'camera', [row('Main', main.el), row('Field of View', fov.el), row('Near', near.el), row('Far', far.el), row('', actions)], [remove]);
    }

    // ---------------------------------------------------------------- model

    /** Selected model nodes of the same model file as the primary one. */
    private sameModel(): string[] {
        const asset = this.node.model?.asset;
        return this.store.selection.filter((id) => this.store.node(id)?.model?.asset === asset);
    }

    private modelHooks<T>(label: string, apply: (model: NonNullable<NodeDoc['model']>, v: T) => void): EditHooks<T> {
        const asset = this.node.model?.asset;
        return this.hooks<T>(label, (n) => n.model?.asset === asset, (n, v) => apply(n.model!, v));
    }

    private modelSections(node: NodeDoc): HTMLElement[] {
        const asset = this.store.doc.assets.find((a) => a.id === node.model!.asset);
        const state = this.editor.sync.modelState(node.id);
        const info = this.editor.sync.modelInfo(node.id);
        const status = state?.status === 'ready' ? 'Loaded' : state?.status === 'error' ? `Failed: ${state.error}` : 'Loading...';
        const rows: HTMLElement[] = [
            row('File', h('div', { class: 'readonly', text: asset ? asset.name : 'Missing asset' })),
            row('Size', h('div', { class: 'readonly', text: asset ? formatBytes(asset.size) : '-' })),
            row('Status', h('div', { class: 'readonly' + (state?.status === 'error' ? ' error-text' : ''), text: status })),
        ];
        if (info) {
            const tris = info.parts.reduce((s, p) => s + p.triangles, 0);
            const verts = info.parts.reduce((s, p) => s + p.vertices, 0);
            rows.push(
                row(
                    'Contents',
                    h('div', { class: 'readonly', text: `${info.parts.length} meshes · ${info.slots.length} materials · ${tris.toLocaleString()} tris · ${verts.toLocaleString()} verts` }),
                ),
            );
        }
        const overrides = Object.keys(node.model!.materials ?? {}).length + Object.keys(node.model!.parts ?? {}).length;
        const menu = iconButton('dots', 'Model options', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                [
                    { label: 'Reset All Overrides', icon: 'undo', enabled: () => overrides > 0, action: () => this.editor.resetModelOverrides(this.sameModel()) },
                    { label: 'Apply to All Instances', icon: 'copy', action: () => this.editor.copyOverridesToInstances(node.id) },
                ],
                r.left - 180,
                r.bottom + 4,
            );
        });
        if (overrides) rows.push(row('Overrides', h('div', { class: 'readonly', text: `${overrides} changed ${overrides === 1 ? 'item' : 'items'}` })));
        const out = [section('model', 'Model', 'model', rows, [menu])];
        if (info) {
            out.push(this.materialSlotsSection(node, info));
            out.push(this.partsSection(node, info));
        }
        return out;
    }

    private materialSlotsSection(node: NodeDoc, info: ModelInfo): HTMLElement {
        const list = h('div', { class: 'slot-list' });
        for (const slot of info.slots) list.appendChild(this.slotItem(node, slot));
        return section('model-materials', `Materials (${info.slots.length})`, 'sphere', [list]);
    }

    private slotItem(node: NodeDoc, slot: ModelSlot): HTMLElement {
        const o: MaterialOverride = node.model!.materials?.[slot.key] ?? {};
        const open = this.openSlots.has(slot.key);
        const focusedSlot = this.editor.focusedPart?.node === node.id ? info(this.editor, node.id)?.part(this.editor.focusedPart.path)?.slot : null;
        const shading = slotShading(o, this.editor.shaders);
        const swatch = h('span', { class: 'swatch', style: { background: o.color ?? slot.base.color } });
        const tag = shading === 'model' ? '' : shading === 'shader' ? this.store.doc.shaders.find((x) => x.id === o.shader)?.name ?? 'shader' : shading;
        const head = h(
            'button',
            { class: 'slot-head' + (open ? ' open' : '') + (focusedSlot === slot.key ? ' focused' : ''), attrs: { type: 'button' } },
            icon('chevron', 12, 'slot-caret'),
            swatch,
            h('span', { class: 'slot-name', text: slot.key }),
            tag ? h('span', { class: 'slot-tag', text: tag }) : null,
            Object.keys(o).length ? h('span', { class: 'override-dot', title: 'Changed from the model file' }) : null,
            h('span', { class: 'slot-count', text: `${slot.parts.length}` , title: `${slot.parts.length} mesh(es) use this material` }),
        );
        head.addEventListener('click', () => {
            if (open) this.openSlots.delete(slot.key);
            else this.openSlots.add(slot.key);
            this.render();
        });
        const item = h('div', { class: 'slot-item' }, head);
        if (!open) return item;

        const b = slot.base;
        const ids = () => this.sameModel();
        const set = <K extends keyof MaterialOverride>(key: K, label: string) =>
            this.modelHooks<MaterialOverride[K]>(label, (model, v) => {
                const map = { ...(model.materials ?? {}) };
                const next = { ...(map[slot.key] ?? {}), [key]: v };
                if (v === undefined) delete (next as any)[key];
                map[slot.key] = next;
                model.materials = map;
            });

        // Shading: the file's PBR material, a built-in material, or a custom shader.
        const shadingSel = new SelectField<string>(SLOT_SHADING, shading, (v) => {
            if (v === 'shader') {
                const shaders = this.store.doc.shaders.filter((x) => x.kind === 'material');
                const id = o.shader && shaders.some((x) => x.id === o.shader) ? o.shader : shaders[0]?.id ?? this.editor.createShader({ template: 'lit' }).id;
                this.editor.setModelMaterial(ids(), slot.key, { shader: id, shading: undefined, params: o.params ?? {} }, 'Material Shader');
                return;
            }
            this.editor.setModelMaterial(ids(), slot.key, { shading: v === 'model' ? undefined : (v as SlotShading), shader: undefined, params: undefined }, 'Material Shading');
        });
        const rows: HTMLElement[] = [row('Shading', shadingSel.el, 'Model: the PBR material from the file. Unlit and Lambert replace it with that engine material. Custom Shader renders with a WGSL material shader.')];
        if (shading === 'shader' || (o.shader && !this.editor.shaders.isValid(o.shader))) {
            rows.push(...this.shaderRows(o.shader ?? null, (id) => this.editor.setModelMaterial(ids(), slot.key, { shader: id ?? undefined, shading: undefined, params: id ? o.params ?? {} : undefined }, 'Material Shader')));
        }

        const color = new ColorField({ value: o.color ?? b.color, ...set('color', 'Material Color') });
        const opacity = new SliderField({ value: o.opacity ?? b.opacity, min: 0, max: 1, step: 0.01, ...set('opacity', 'Material Opacity') });
        const slotModes = ALPHA_MODES.map((m) => (m.value === 'auto' ? { value: m.value, label: `From file (${FILE_ALPHA[b.alpha] ?? 'opaque'})` } : m));
        const alpha = new SelectField<AlphaMode>(slotModes, o.alphaMode ?? 'auto', (v) => set('alphaMode', 'Material Alpha').commit!(v === 'auto' ? undefined : v));
        rows.push(row('Color', color.el), row('Opacity', opacity.el), row('Alpha', alpha.el, 'From file keeps the model\'s own mode; lowering Opacity makes it blend'));
        let cutoff: SliderField | null = null;
        if (o.alphaMode === 'mask' || (!o.alphaMode && b.alpha === 'MASK')) {
            cutoff = new SliderField({ value: o.alphaCutoff ?? b.alphaCutoff, min: 0, max: 1, step: 0.01, ...set('alphaCutoff', 'Material Alpha Cutoff') });
            rows.push(row('Cutoff', cutoff.el));
        }
        const pbrValues = shading === 'model' || shading === 'shader';
        const metallic = new SliderField({ value: o.metallic ?? b.metallic, min: 0, max: 1, step: 0.01, ...set('metallic', 'Material Metallic') });
        const roughness = new SliderField({ value: o.roughness ?? b.roughness, min: 0, max: 1, step: 0.01, ...set('roughness', 'Material Roughness') });
        const emissive = new ColorField({ value: o.emissive ?? b.emissive, ...set('emissive', 'Material Emissive') });
        const emissiveI = new NumberField({ value: o.emissiveIntensity ?? b.emissiveIntensity, step: 0.05, min: 0, precision: 2, ...set('emissiveIntensity', 'Material Emission') });
        if (pbrValues) rows.push(row('Metallic', metallic.el), row('Roughness', roughness.el), row('Emissive', emissive.el), row('Emission', emissiveI.el, 'Emissive intensity'));

        const extra: (() => void)[] = [];
        if (shading === 'model' && b.pbr) {
            const normal = new SliderField({ value: o.normalScale ?? b.normalScale, min: 0, max: 2, step: 0.01, ...set('normalScale', 'Material Normal Strength') });
            const coat = new SliderField({ value: o.clearcoat ?? b.clearcoat, min: 0, max: 1, step: 0.01, ...set('clearcoat', 'Material Clear Coat') });
            const coatR = new SliderField({ value: o.clearcoatRoughness ?? b.clearcoatRoughness, min: 0, max: 1, step: 0.01, ...set('clearcoatRoughness', 'Material Coat Roughness') });
            const trans = new SliderField({ value: o.transmission ?? b.transmission, min: 0, max: 1, step: 0.01, ...set('transmission', 'Material Transmission') });
            const ior = new SliderField({ value: o.ior ?? b.ior, min: 1, max: 2.5, step: 0.01, ...set('ior', 'Material IOR') });
            rows.push(
                row('Normal Str.', normal.el, 'Strength of the file\'s normal map'),
                row('Coat', coat.el, 'Clear coat layer'),
                row('Coat Rough.', coatR.el),
                row('Transmission', trans.el, 'Light passing through the surface (glass)'),
                row('IOR', ior.el, 'Index of refraction'),
            );
            extra.push(() => {
                const cur = this.node.model?.materials?.[slot.key] ?? {};
                normal.set(cur.normalScale ?? b.normalScale);
                coat.set(cur.clearcoat ?? b.clearcoat);
                coatR.set(cur.clearcoatRoughness ?? b.clearcoatRoughness);
                trans.set(cur.transmission ?? b.transmission);
                ior.set(cur.ior ?? b.ior);
            });
        }
        const doubleSide = new CheckboxField(o.doubleSide ?? b.doubleSide, (v) => set('doubleSide', 'Material Double Sided').commit!(v));
        const textures = this.store.doc.assets.filter((a) => a.kind === 'texture');
        const mapValue = o.map === undefined ? '__file' : o.map === null ? '' : o.map;
        const map = new SelectField<string>(
            [
                ...(b.hasMap ? [{ value: '__file', label: 'From model file' }] : [{ value: '__file', label: 'None (file)' }]),
                { value: '', label: 'None' },
                ...textures.map((t) => ({ value: t.id, label: t.name })),
            ],
            mapValue,
            (v) => this.editor.setModelMaterial(ids(), slot.key, { map: v === '__file' ? undefined : v || null }, 'Material Texture'),
        );
        rows.push(row('Double Sided', doubleSide.el), row('Texture', h('div', { class: 'inline' }, map.el, iconButton('upload', 'Import image', () => this.editor.importTextureDialog()))));
        if (shading === 'shader' && o.shader) {
            const shaderId = o.shader;
            const props = this.editor.shaders.props(shaderId);
            if (props.length) {
                const watchers: ((v: Record<string, ParamValue>) => void)[] = [];
                rows.push(h('div', { class: 'group-label', text: 'Shader Properties' }));
                rows.push(
                    ...shaderParamRows(
                        props,
                        o.params ?? {},
                        (name, label) =>
                            this.modelHooks<ParamValue>(label, (model, v) => {
                                const m = { ...(model.materials ?? {}) };
                                const cur = m[slot.key] ?? {};
                                m[slot.key] = { ...cur, params: { ...(cur.params ?? {}), [name]: v } };
                                model.materials = m;
                            }),
                        textures,
                        (fn) => watchers.push(fn),
                        true,
                    ),
                );
                extra.push(() => {
                    const params = this.node.model?.materials?.[slot.key]?.params ?? {};
                    for (const w of watchers) w(params);
                });
            }
        }
        const reset = button('Reset', () => this.editor.setModelMaterial(ids(), slot.key, null, 'Reset Material'), 'small subtle', 'undo');
        rows.push(row('', h('div', { class: 'inline' }, reset, h('span', { class: 'muted small', text: `${slot.parts.length} mesh(es)` }))));
        this.watch(() => {
            const cur = this.node.model?.materials?.[slot.key] ?? {};
            shadingSel.set(slotShading(cur, this.editor.shaders));
            color.set(cur.color ?? b.color);
            opacity.set(cur.opacity ?? b.opacity);
            alpha.set(cur.alphaMode ?? 'auto');
            cutoff?.set(cur.alphaCutoff ?? b.alphaCutoff);
            metallic.set(cur.metallic ?? b.metallic);
            roughness.set(cur.roughness ?? b.roughness);
            emissive.set(cur.emissive ?? b.emissive);
            emissiveI.set(cur.emissiveIntensity ?? b.emissiveIntensity);
            doubleSide.set(cur.doubleSide ?? b.doubleSide);
            map.set(cur.map === undefined ? '__file' : cur.map === null ? '' : cur.map);
            swatch.style.background = cur.color ?? b.color;
            for (const fn of extra) fn();
        });
        item.appendChild(h('div', { class: 'slot-body' }, rows));
        return item;
    }

    private partsSection(node: NodeDoc, info: ModelInfo): HTMLElement {
        const list = h('div', { class: 'part-list' });
        const rows: HTMLElement[] = [];
        if (info.parts.length > 8) {
            const search = h('input', { class: 'search', attrs: { type: 'search', placeholder: 'Filter meshes', spellcheck: 'false' } });
            search.value = this.partFilter;
            search.addEventListener('keydown', (e) => e.stopPropagation());
            search.addEventListener('input', () => {
                this.partFilter = search.value.trim().toLowerCase();
                this.fillParts(list, node, info);
            });
            rows.push(h('div', { class: 'panel-search inset' }, icon('search', 14), search));
        }
        rows.push(list);
        this.fillParts(list, node, info);
        const allShown = info.parts.every((p) => node.model!.parts?.[p.path]?.visible !== false);
        const toggleAll = iconButton(allShown ? 'eye' : 'eyeOff', 'Show / hide all meshes', () => {
            const ids = this.sameModel();
            this.store.commit('Toggle Meshes', (doc) => {
                for (const n of doc.nodes) {
                    if (!ids.includes(n.id) || !n.model) continue;
                    const parts = { ...(n.model.parts ?? {}) };
                    for (const p of info.parts) {
                        const cur = { ...(parts[p.path] ?? {}) };
                        if (allShown) cur.visible = false;
                        else delete cur.visible;
                        if (Object.keys(cur).length) parts[p.path] = cur;
                        else delete parts[p.path];
                    }
                    if (Object.keys(parts).length) n.model.parts = parts;
                    else delete n.model.parts;
                }
            }, { nodes: ids });
        });
        return section('model-parts', `Meshes (${info.parts.length})`, 'cube', rows, [toggleAll]);
    }

    private fillParts(list: HTMLElement, node: NodeDoc, info: ModelInfo) {
        clear(list);
        const parts = this.partFilter ? info.parts.filter((p) => p.path.toLowerCase().includes(this.partFilter)) : info.parts;
        for (const part of parts.slice(0, MAX_PARTS)) list.appendChild(this.partItem(node, info, part));
        if (parts.length > MAX_PARTS) list.appendChild(h('div', { class: 'muted small pad', text: `${parts.length - MAX_PARTS} more; use the filter to find them.` }));
        if (!parts.length) list.appendChild(h('div', { class: 'muted small pad', text: 'No meshes match.' }));
    }

    private partItem(node: NodeDoc, info: ModelInfo, part: ModelPart): HTMLElement {
        const po: PartOverride = node.model!.parts?.[part.path] ?? {};
        const open = this.openParts.has(part.path);
        const focused = this.editor.focusedPart?.node === node.id && this.editor.focusedPart.path === part.path;
        const visible = po.visible !== false;
        const eye = h('button', { class: 'tree-eye' + (visible ? '' : ' off'), title: visible ? 'Hide mesh' : 'Show mesh', attrs: { type: 'button' } }, icon(visible ? 'eye' : 'eyeOff', 13));
        eye.addEventListener('click', (e) => {
            e.stopPropagation();
            this.editor.setModelPart(this.sameModel(), part.path, { visible: visible ? false : undefined }, visible ? 'Hide Mesh' : 'Show Mesh');
        });
        const slotKey = po.material ?? part.slot;
        const head = h(
            'div',
            { class: 'part-row' + (open ? ' open' : '') + (focused ? ' focused' : '') + (visible ? '' : ' hidden-node'), attrs: { role: 'button', tabindex: 0 } },
            icon('chevron', 12, 'slot-caret'),
            h('span', { class: 'part-name', text: part.name, title: part.path }),
            Object.keys(po).length ? h('span', { class: 'override-dot', title: 'Changed from the model file' }) : null,
            h('span', { class: 'part-meta', text: `${slotKey} · ${part.triangles.toLocaleString()} tris` }),
            eye,
        );
        head.addEventListener('click', () => {
            if (open) this.openParts.delete(part.path);
            else this.openParts.add(part.path);
            this.editor.focusPart(node.id, open ? null : part.path);
            this.render();
        });
        const item = h('div', { class: 'part-item' }, head);
        if (!open) return item;

        const slot = new SelectField<string>(
            info.slots.map((s) => ({ value: s.key, label: s.key + (s.key === part.slot ? ' (original)' : '') })),
            slotKey,
            (v) => this.editor.setModelPart(this.sameModel(), part.path, { material: v === part.slot ? undefined : v }, 'Mesh Material'),
        );
        const cast = new CheckboxField(po.castShadow ?? part.base.castShadow, (v) => this.editor.setModelPart(this.sameModel(), part.path, { castShadow: v }, 'Mesh Cast Shadow'), 'Cast');
        const receive = new CheckboxField(po.receiveShadow ?? part.base.receiveShadow, (v) => this.editor.setModelPart(this.sameModel(), part.path, { receiveShadow: v }, 'Mesh Receive Shadow'), 'Receive');
        const setT = (key: 'position' | 'rotation' | 'scale', label: string) =>
            this.modelHooks<Vec3>(label, (model, v) => {
                const parts = { ...(model.parts ?? {}) };
                parts[part.path] = { ...(parts[part.path] ?? {}), [key]: v };
                model.parts = parts;
            });
        const pos = new Vec3Field({ value: po.position ?? part.base.position, step: 0.01, precision: 3, ...setT('position', 'Move Mesh') });
        const rot = new Vec3Field({ value: po.rotation ?? part.base.rotation, step: 0.5, precision: 2, ...setT('rotation', 'Rotate Mesh') });
        const scl = new Vec3Field({ value: po.scale ?? part.base.scale, step: 0.01, precision: 3, ...setT('scale', 'Scale Mesh') });
        this.watch(() => {
            const cur = this.node.model?.parts?.[part.path] ?? {};
            slot.set(cur.material ?? part.slot);
            cast.set(cur.castShadow ?? part.base.castShadow);
            receive.set(cur.receiveShadow ?? part.base.receiveShadow);
            pos.set(cur.position ?? part.base.position);
            rot.set(cur.rotation ?? part.base.rotation);
            scl.set(cur.scale ?? part.base.scale);
        });
        const reset = button('Reset', () => this.editor.setModelPart(this.sameModel(), part.path, null, 'Reset Mesh'), 'small subtle', 'undo');
        item.appendChild(
            h(
                'div',
                { class: 'slot-body' },
                row('Material', slot.el),
                row('Shadows', h('div', { class: 'inline' }, cast.el, receive.el)),
                row('Position', pos.el),
                row('Rotation', rot.el),
                row('Scale', scl.el),
                row('', h('div', { class: 'inline' }, reset, h('span', { class: 'muted small', text: `${part.vertices.toLocaleString()} verts` }))),
            ),
        );
        return item;
    }

    // --------------------------------------------------------------- scripts

    private scriptSection(node: NodeDoc, ref: ScriptRef, index: number): HTMLElement {
        const doc = this.store.doc.scripts.find((s) => s.id === ref.script);
        const compiled = this.editor.compiler.get(ref.script);
        const rows: HTMLElement[] = [];
        if (compiled?.paused) {
            rows.push(
                h(
                    'div',
                    { class: 'script-paused' },
                    h('span', { class: 'muted small', text: 'Paused: this script came with an opened scene file. Its fields show up once scripts are enabled.' }),
                    button('Enable Scripts', () => this.editor.enableScripts(), 'small'),
                ),
            );
        } else if (compiled?.error) {
            const err = h('div', { class: 'readonly error-text', text: `Line ${compiled.error.line || '?'}: ${compiled.error.message}` });
            rows.push(row('Error', err));
        } else if (compiled?.fieldError) {
            rows.push(row('Fields', h('div', { class: 'readonly error-text', text: compiled.fieldError })));
        }
        if (compiled?.fields.length) {
            const watchers: ((v: Record<string, ParamValue>) => void)[] = [];
            rows.push(
                ...scriptFieldRows(
                    compiled.fields,
                    ref.props,
                    (name, label) =>
                        this.hooks<ParamValue>(label, (n) => !!n.scripts?.some((r) => r.script === ref.script), (n, v) => {
                            const r = n.scripts!.find((x) => x.script === ref.script)!;
                            r.props = { ...r.props, [name]: v };
                        }),
                    (fn) => watchers.push(fn),
                ),
            );
            this.watch(() => {
                const r = this.node.scripts?.[index];
                if (r) for (const w of watchers) w(r.props);
            });
        } else if (compiled && !compiled.error) {
            rows.push(h('div', { class: 'muted small pad', text: 'Public fields of the class show up here.' }));
        }
        const enabled = new CheckboxField(ref.enabled, (v) => {
            this.store.commit(v ? 'Enable Script' : 'Disable Script', (d) => {
                const n = d.nodes.find((x) => x.id === node.id);
                const r = n?.scripts?.[index];
                if (r) r.enabled = v;
            }, { nodes: [node.id] });
        });
        enabled.el.title = 'Enabled';
        const edit = iconButton('code', 'Edit script', () => this.editor.emit('open-code', { kind: 'script', id: ref.script }));
        const menu = iconButton('dots', 'Script options', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                [
                    {
                        label: 'Reset Fields',
                        icon: 'undo',
                        enabled: () => Object.keys(ref.props).length > 0,
                        action: () =>
                            this.store.commit('Reset Script Fields', (d) => {
                                const r2 = d.nodes.find((x) => x.id === node.id)?.scripts?.[index];
                                if (r2) r2.props = {};
                            }, { nodes: [node.id] }),
                    },
                    { label: 'Remove Script', icon: 'trash', action: () => this.editor.detachScript(node.id, index) },
                ],
                r.left - 160,
                r.bottom + 4,
            );
        });
        const title = doc ? doc.name : 'Missing script';
        return section(`script-${index}`, title, 'script', rows, [enabled.el, edit, menu]);
    }

    private addComponent(node: NodeDoc): HTMLElement {
        const items: MenuItem[] = [];
        if (!node.mesh && !node.model && !node.camera) {
            items.push({
                label: 'Mesh',
                icon: 'cube',
                action: () => this.hooks<null>('Add Mesh', (n) => !n.mesh && !n.model, (n) => {
                    n.mesh = { geometry: defaultGeometry('box'), material: defaultMaterial(), castShadow: true, receiveShadow: true };
                }).commit!(null),
            });
        }
        if (!node.light && !node.camera) {
            for (const t of LIGHT_OPTIONS) {
                items.push({
                    label: t.label + ' Light',
                    icon: t.value === 'directional' ? 'sun' : t.value === 'point' ? 'bulb' : 'spot',
                    action: () => this.hooks<null>('Add Light', (n) => !n.light, (n) => (n.light = defaultLight(t.value))).commit!(null),
                });
            }
        }
        if (!node.camera && !node.mesh && !node.light && !node.model) {
            items.push({
                label: 'Camera',
                icon: 'camera',
                action: () => this.hooks<null>('Add Camera', (n) => !n.camera, (n) => (n.camera = defaultCameraDoc())).commit!(null),
            });
        }
        if (items.length) items.push({ separator: true });
        const scripts = this.store.doc.scripts;
        items.push({
            label: 'Script',
            icon: 'script',
            submenu: [
                ...scripts.map((s) => ({ label: s.name, icon: 'script', action: () => this.editor.attachScript(this.store.selection, s.id) })),
                ...(scripts.length ? [{ separator: true } as MenuItem] : []),
                ...SCRIPT_TEMPLATES.map((t) => ({
                    label: `New: ${t.label}`,
                    icon: 'plus',
                    action: () => this.editor.createScript({ name: t.id === 'empty' ? 'NewScript' : t.label.replace(/\s+/g, ''), template: t.id, attachTo: this.store.selection }),
                })),
            ],
        });
        const btn = button('Add Component', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(items, r.left, r.bottom + 4);
        }, 'add-component', 'plus');
        return h('div', { class: 'add-component-row' }, btn);
    }
}

function info(editor: Editor, id: string): ModelInfo | null {
    return editor.sync.modelInfo(id);
}
