import type { z } from 'zod';
import { PARTICLE_PRESETS, particleCount, presetParticles } from '../core/particles';
import { defaultCharacter, defaultPlayer } from '../core/character';
import {
    Animation, ANIMATION_MODES, AudioSource, Body, Camera, Character, Grass, Instancing, Light, LightShadow, Material, Mirror, Particles, Player, Rain, Scatter, ScatterSource, Terrain,
    TerrainLayer, Tree,
} from '../core/model';
import { SPECIES_HEIGHT, SPECIES_NAME, TREE_SPECIES, type TreeSpecies } from '../core/trees';
import { defaults, inner } from '../core/schema';
import type { Editor } from '../editor';
import type { ChangeHint } from '../core/store';
import { layerFromSlot, unassignSlot } from '../design/materialSlots';
import type { BrushTool } from '../design/terrainEdit';
import type { Heightmap } from '../core/heightmap';
import { onChanges } from './batch';
import { formatBytes } from '../core/assets';
import { defaultCameraDoc, defaultGeometry, defaultLight, defaultMaterial, defaultTree } from '../core/defaults';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES } from '../core/templates';
import type {
    AlphaMode, AssetMeta, GeometryType, LightType, MaterialDoc, MaterialOverride, MaterialType, NodeDoc, ParamValue, PartOverride, ScatterSourceDoc, ScriptRef,
    SlotShading, TextureRole, TreeDoc, Vec3,
} from '../core/types';
import { MATERIAL_PRESETS } from '../core/materialPresets';
import { MAP_ROLES } from '../core/refs';
import { openTextureOptions } from './textureOptions';
import { slotShading, type ModelInfo, type ModelPart, type ModelSlot } from '../engine/modelParts';
import { schemaOf } from '../core/behavior/format';
import { formatValue, keyTypeInfo } from '../core/behavior/nodeTypes';
import { validateAgent } from '../core/behavior/validate';
import { valueControl } from './behavior/fields';
import { clear, h, pressable } from './dom';
import { icon, nodeIcon } from './icons';
import { mascotPose } from './mascot';
import { MenuItem, showMenu, toast } from './overlays';
import { openLibraryDialog } from './libraryDialog';
import { toggleSound } from './soundPreview';
import { scriptFieldRows, shaderParamRows } from './paramFields';
import { schemaRows } from './schemaFields';
import { clipFor } from '../play/animation';
import {
    CheckboxField, ColorField, EditHooks, FieldSteps, NumberField, SelectField, SliderField, TextField, Vec3Field, button,
    iconButton, row, section,
} from './widgets';

const GEOMETRY_OPTIONS: { value: GeometryType; label: string }[] = [
    { value: 'box', label: 'Box' },
    { value: 'sphere', label: 'Sphere' },
    { value: 'plane', label: 'Plane' },
    { value: 'cylinder', label: 'Cylinder' },
    { value: 'cone', label: 'Cone' },
    { value: 'torus', label: 'Torus' },
    { value: 'ramp', label: 'Ramp' },
    { value: 'stairs', label: 'Stairs' },
    { value: 'capsule', label: 'Capsule' },
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

/** Components whose inspector fields come from their schemas, and where they are in a node. */
const COMPONENTS = {
    light: [Light, (n: NodeDoc) => n.light],
    lightShadow: [LightShadow, (n: NodeDoc) => n.light?.shadow],
    camera: [Camera, (n: NodeDoc) => n.camera],
    particles: [Particles, (n: NodeDoc) => n.particles],
    character: [Character, (n: NodeDoc) => n.character],
    player: [Player, (n: NodeDoc) => n.player],
    body: [Body, (n: NodeDoc) => n.body],
    material: [Material, (n: NodeDoc) => n.mesh?.material],
    mirror: [Mirror, (n: NodeDoc) => n.mirror],
    grass: [Grass, (n: NodeDoc) => n.grass],
    rain: [Rain, (n: NodeDoc) => n.rain],
    terrain: [Terrain, (n: NodeDoc) => n.terrain],
    scatter: [Scatter, (n: NodeDoc) => n.scatter],
    tree: [Tree, (n: NodeDoc) => n.tree],
    audio: [AudioSource, (n: NodeDoc) => n.audio],
    // Made on the first edit: every model with clips shows the section.
    animation: [Animation, (n: NodeDoc) => n.animation, 'animation'],
} as const;

type Filter = (n: NodeDoc) => boolean;
/** Finds an object inside a node the rows edit: a component, or an item of a component's list. */
type Getter = (n: NodeDoc) => Record<string, unknown> | undefined;

const BRUSH_TOOLS: { value: BrushTool; label: string; hint: string }[] = [
    { value: 'raise', label: 'Raise', hint: 'Raise the ground while held (Shift lowers it)' },
    { value: 'lower', label: 'Lower', hint: 'Lower the ground while held (Shift raises it)' },
    { value: 'flatten', label: 'Flatten', hint: 'Level the ground to the height where the stroke starts: building sites, plateaus' },
    { value: 'smooth', label: 'Smooth', hint: 'Even out bumps' },
    { value: 'path', label: 'Path', hint: 'Level a walkable way across the stroke, keeping the slope along it' },
    { value: 'paint', label: 'Paint', hint: 'Paint a layer: it takes over from the others where painted' },
];

/** Meters with one decimal. */
const meters = (v: number) => String(Math.round(v * 10) / 10);

/** A scatter source's choice that grows a tree of a species (after it): the others are model asset ids. */
const TREE_CHOICE = 'tree:';

/** The fields of a scatter's tree source shown (the scatter's own cast shadows and solids hold for it). */
const SCATTER_TREE_ROWS = ['seed', 'height', 'width', 'trunk', 'branches', 'leaves', 'leafSize', 'gnarl', 'autumn', 'leafTint', 'barkTint', 'translucency', 'vary', 'wind'] as const;

/** What a scatter source places, as its choice: a model asset id, a tree of a species, or '' for nothing. */
const sourceChoice = (src: ScatterSourceDoc): string => (src.tree ? TREE_CHOICE + src.tree.species : src.model ?? '');

/**
 * Makes a scatter source place what was chosen: a model, a tree of a
 * species (one already a tree keeps how it grows) or nothing. The first
 * tree of a scatter spaces its copies apart and makes its trunk solid, as
 * trees need room and stop characters.
 */
function chooseSource(n: NodeDoc, src: ScatterSourceDoc, choice: string) {
    if (!choice.startsWith(TREE_CHOICE)) {
        src.model = choice || null;
        delete src.tree;
        return;
    }
    const species = choice.slice(TREE_CHOICE.length) as TreeSpecies;
    if (!src.tree) {
        if (n.scatter && !n.scatter.sources.some((x) => x.tree) && n.scatter.spacing < 3) n.scatter.spacing = 4;
        if (src.solid === 'none') src.solid = 'trunk';
    }
    src.tree = src.tree ? { ...src.tree, species } : (defaultTree(species) satisfies TreeDoc);
    src.model = null;
}

/** The lowest and highest sample of each heightmap shown (a sculpt stroke makes a new map). */
const extremes = new WeakMap<Heightmap, [number, number]>();
function extremesOf(map: Heightmap): [number, number] {
    let known = extremes.get(map);
    if (!known) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of map.data) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        known = [lo, hi];
        extremes.set(map, known);
    }
    return known;
}

/** Property editor for the selected object(s). Edits apply to every selected object that has the property. */
export class InspectorPanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private syncs: (() => void)[] = [];
    /** The syncs of the transform fields, all a move changes. */
    private moves: (() => void)[] = [];
    private shape = '';
    /** The versions of what it shows, when it last showed them (see follow). */
    private seen = { node: '', version: -1, parts: -1, structure: -1 };
    private steps: FieldSteps;
    private openSlots = new Set<string>();
    private openParts = new Set<string>();
    private partFilter = '';
    /** The object the mesh filter was typed for: another object starts unfiltered. */
    private partFilterFor = '';
    /** Shows the terrain brush's settings again (while a terrain's section is shown). */
    private brushSync: (() => void) | null = null;

    constructor(private editor: Editor, private showScene: () => void) {
        this.body = h('div', { class: 'panel-body inspector-body' });
        this.el = h('div', { class: 'panel inspector' }, this.body);
        const store = editor.store;
        this.steps = new FieldSteps(store);
        store.on('selection', () => this.render());
        onChanges(store, (hint) => this.follow(hint));
        editor.sync.on('model', (id) => {
            if (store.selection.includes(id)) this.render();
        });
        editor.shaders.on('status', () => {
            if (this.shapeKey() !== this.shape) this.render();
        });
        editor.compiler.on('compiled', () => {
            if (this.shapeKey() !== this.shape) this.render();
        });
        editor.player.on('state', () => {
            if (this.shapeKey() !== this.shape) this.render();
        });
        editor.on('brush', () => this.brushSync?.());
        // A terrain's heights and a scatter's copies change without an edit of the object (strokes, loads, placing).
        const shown = (id: string) => {
            if (id === store.primary?.id) for (const sync of this.syncs) sync();
        };
        editor.sync.on('terrain', shown);
        editor.sync.on('scatter', shown);
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
            // Shadow settings show while the light casts, the cascades with them.
            n.light ? n.light.type + (n.light.castShadow ? ':shadow:' + n.light.shadow?.coverage : '') : '-',
            n.particles ? 'fx:' + n.particles.shape : '-',
            n.camera ? 'cam' : '-',
            (n.character ? 'char' : '-') + (n.player ? ':player:' + n.player.view : ''),
            n.body ? 'body:' + n.body.type : '-',
            (n.mirror ? 'mirror' : '-') + (n.instancing ? ':inst' : ''),
            // The ground choices list the objects.
            n.grass ? 'grass:' + this.store.doc.nodes.length : '-',
            // The shelter and light choices list the objects.
            n.rain ? 'rain:' + this.store.doc.nodes.length : '-',
            // A layer shows its own maps or follows a slot, from the slots listed.
            n.terrain ? 'terrain:' + n.terrain.layers.map((l) => l.slot ?? '-').join(',') + ':' + this.store.doc.design.materials.map((m) => m.id + m.name).join(',') : '-',
            // A source shows a model's rows or a tree's.
            n.scatter ? 'scatter:' + n.scatter.sources.map((x) => (x.tree ? 't' : 'm')).join('') + ':' + n.scatter.avoid.join(',') + ':' + this.store.doc.nodes.length : '-',
            n.tree ? 'tree' : '-',
            n.prefab ? this.prefabKey(n.prefab) : '-',
            n.model ? n.model.asset + ':' + (this.editor.sync.modelState(n.id)?.status ?? '') + ':' + (info ? info.parts.length : 0) : '-',
            n.model ? JSON.stringify(Object.keys(n.model.materials ?? {})) + JSON.stringify(Object.keys(n.model.parts ?? {})) : '',
            n.model ? Object.values(n.model.materials ?? {}).map((o) => (o.shading ?? '') + (o.alphaMode ?? '') + (o.shader ?? '') + this.propsKey(o.shader ?? '')).join(',') : '',
            (n.scripts ?? []).map((r) => r.script + ':' + this.scriptKey(r.script)).join(','),
            this.agentKey(n),
            this.store.doc.assets.length,
            this.store.doc.scripts.map((s) => s.id + s.name).join(','),
            this.store.doc.shaders.map((s) => s.id + s.name + s.kind + s.lighting).join(','),
        ].join('|');
    }

    /** What the Prefab section shows: template or model, whether a model exists, how many instances. */
    private prefabKey(id: string): string {
        const p = this.editor.prefab(id);
        if (!p) return 'missing';
        const hasModel = this.store.doc.assets.some((a) => a.id === p.asset);
        return `${p.name}:${p.useModel ? 'model' : 'template'}:${hasModel}:${this.editor.instancesOf(id).length}`;
    }

    private propsKey(shaderId: string): string {
        if (!shaderId) return '';
        return this.editor.shaders.props(shaderId).map((p) => p.name + p.type).join(',') + ':' + this.editor.shaders.status(shaderId).state;
    }

    /** The tree and keys an agent section shows (values and overrides update in place). */
    private agentKey(n: NodeDoc): string {
        if (!n.agent) return '-';
        const doc = this.store.doc;
        const tree = doc.behaviors.find((t) => t.id === n.agent!.tree);
        const schema = schemaOf(doc.blackboards, tree);
        return [
            n.agent.tree,
            doc.behaviors.map((t) => t.id + '=' + t.name).join(','),
            schema ? schema.id + ':' + schema.keys.map((k) => `${k.name}/${k.type}/${k.owner}/${(k.values ?? []).map((v) => v.value).join('.')}`).join(',') : '',
            this.editor.player.state === 'stopped' ? 'edit' : 'play',
        ].join(';');
    }

    private scriptKey(id: string): string {
        const c = this.editor.compiler.get(id);
        if (!c) return 'missing';
        return (c.paused ? 'paused' : c.error ? 'err' : 'ok') + c.fields.map((f) => f.name + f.type).join(',') + (c.fieldError ? 'fe' : '');
    }

    private refresh() {
        for (const s of this.syncs) s();
        this.seen = this.versions();
    }

    /** The versions of what it shows: the primary object, the parts of the document and its structure (prefab instances). */
    private versions() {
        const id = this.store.primary?.id ?? '';
        return { node: id, version: id ? this.store.nodeVersion(id) : 0, parts: this.store.partsVersion, structure: this.store.structureVersion };
    }

    /**
     * Follows the changes of a frame: nothing when what it shows kept its
     * versions, the values when the object only moved, else its sections
     * when they are no longer the same (shapeKey) or their values.
     */
    private follow(hint: ChangeHint | undefined) {
        const was = this.seen;
        const now = this.versions();
        if (now.node === was.node && now.version === was.version && now.parts === was.parts && now.structure === was.structure) return;
        if (hint?.transform && now.node === was.node && now.parts === was.parts && now.structure === was.structure) {
            for (const s of this.moves) s();
            this.seen = now;
        } else if (this.shapeKey() !== this.shape) this.render();
        else this.refresh();
    }

    render() {
        this.steps.close();
        this.shape = this.shapeKey();
        this.seen = this.versions();
        this.syncs = [];
        this.moves = [];
        this.brushSync = null;
        const scroll = this.body.scrollTop;
        clear(this.body);
        const node = this.store.primary;
        if (node?.id !== this.partFilterFor) {
            this.partFilter = '';
            this.partFilterFor = node?.id ?? '';
        }
        if (!node) {
            this.body.append(
                h(
                    'div',
                    { class: 'inspector-empty' },
                    mascotPose('rest', 128),
                    h('p', { text: 'Select an object in the viewport or the hierarchy to edit it.' }),
                    button('Scene settings', () => this.showScene(), 'subtle', 'sliders'),
                ),
            );
            return;
        }
        this.body.append(this.header(node));
        this.body.append(this.transformSection());
        if (node.prefab) this.body.append(this.prefabSection(node));
        if (node.mesh) {
            this.body.append(this.meshSection());
            this.body.append(this.materialSection());
        }
        if (node.light) this.body.append(this.lightSection());
        if (node.particles) this.body.append(this.particlesSection());
        if (node.camera) this.body.append(this.cameraSection());
        if (node.character) this.body.append(this.characterSection());
        if (node.player) this.body.append(this.playerSection());
        if (node.body) this.body.append(this.physicsSection());
        if (node.mirror && node.mesh) this.body.append(this.mirrorSection());
        if (node.grass) this.body.append(this.grassSection());
        if (node.rain) this.body.append(this.rainSection());
        if (node.terrain) this.body.append(this.terrainSection());
        if (node.scatter) this.body.append(this.scatterSection());
        if (node.tree) this.body.append(this.treeSection());
        if (node.instancing) this.body.append(this.instancingSection());
        if (node.audio) this.body.append(this.audioSection());
        if (node.model) this.body.append(...this.modelSections(node));
        (node.scripts ?? []).forEach((ref, i) => this.body.append(this.scriptSection(node, ref, i)));
        if (node.agent) this.body.append(this.agentSection(node));
        this.body.append(this.addComponent(node));
        this.body.scrollTop = scroll;
    }

    // -------------------------------------------------------------- binding

    /**
     * Edit hooks that write `apply` to every selected node passing `filter`.
     * With `read`, a vector field changes only the component that was edited
     * on each node: the other components of a multi-selection stay their own.
     * `transform`: the field only moves, turns or scales the nodes.
     */
    private hooks<T>(label: string, filter: Filter, apply: (n: NodeDoc, v: T) => void, read?: (n: NodeDoc) => T | undefined, transform = false): EditHooks<T> {
        const store = this.store;
        const write = (v: T, part?: number) => {
            const ids = store.selection.filter((id) => {
                const n = store.node(id);
                return n && filter(n);
            });
            store.update(() => {
                for (const id of ids) {
                    const n = store.node(id)!;
                    const cur = part !== undefined && read ? read(n) : undefined;
                    if (Array.isArray(cur) && Array.isArray(v)) {
                        const next = [...cur];
                        next[part!] = v[part!];
                        apply(n, next as T);
                    } else apply(n, v);
                }
            }, transform ? { nodes: ids, transform } : { nodes: ids });
        };
        return this.steps.hooks(label, write);
    }

    /** Runs `fn` to show the document's values again (`move`: also after the object only moved). */
    private watch(fn: () => void, move = false) {
        const sync = () => {
            if (this.store.primary) fn();
        };
        this.syncs.push(sync);
        if (move) this.moves.push(sync);
    }

    private get node(): NodeDoc {
        return this.store.primary!;
    }

    /**
     * Rows for fields of a component, made from its schema (core/model.ts).
     * An edit writes the field on the selected objects `filter` passes (those
     * with the component) and repairs the component with its schema, so it
     * stays valid (a range in order, a body no thinner than its radius).
     */
    private componentRows(comp: keyof typeof COMPONENTS, keys: readonly string[], filter?: Filter): HTMLElement[] {
        const [schema, get, make] = COMPONENTS[comp] as unknown as [z.ZodObject, Getter, (keyof NodeDoc)?];
        return this.fieldRows(schema, get, keys, filter, make);
    }

    /**
     * Rows for fields of an object `get` finds in each selected node (a
     * component, or an item of its list), from the object's schema; `make`
     * names the component made on the first edit where it is missing.
     */
    private fieldRows(schema: z.ZodObject, get: Getter, keys: readonly string[], filter?: Filter, make?: keyof NodeDoc): HTMLElement[] {
        const value = (n: NodeDoc) => get(n) ?? (make ? defaults(schema) : undefined);
        const fields = schemaRows(schema, keys, value(this.node)!, (key, label) =>
            this.hooks(label, filter ?? ((n) => !!get(n)), (n, v) => {
                const next = schema.parse({ ...get(n), [key]: v });
                if (get(n)) Object.assign(get(n)!, next);
                else (n as unknown as Record<string, unknown>)[make!] = next;
            }, (n) => value(n)?.[key]),
        );
        this.watch(() => {
            const cur = value(this.node);
            if (cur) fields.set(cur);
        });
        return fields.rows;
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
            ...this.hooks<Vec3>('Move', all, (n, v) => (n.position = v), (n) => n.position, true),
        });
        const rot = new Vec3Field({
            value: this.node.rotation,
            step: 0.5,
            precision: 2,
            ...this.hooks<Vec3>('Rotate', all, (n, v) => (n.rotation = v), (n) => n.rotation, true),
        });
        const scl = new Vec3Field({
            value: this.node.scale,
            step: 0.01,
            precision: 3,
            ...this.hooks<Vec3>('Scale', all, (n, v) => (n.scale = v), (n) => n.scale, true),
        });
        this.watch(() => {
            pos.set(this.node.position);
            rot.set(this.node.rotation);
            scl.set(this.node.scale);
        }, true);
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

    // --------------------------------------------------------------- prefab

    private prefabSection(node: NodeDoc): HTMLElement {
        const editor = this.editor;
        const prefab = editor.prefab(node.prefab);
        if (!prefab) return section('prefab', 'Prefab', 'prefab', [h('div', { class: 'readonly error-text', text: 'The prefab of this instance is missing.' })]);
        const count = editor.instancesOf(prefab.id).length;
        const model = this.store.doc.assets.find((a) => a.id === prefab.asset);
        const name = new TextField(prefab.name, (v) => editor.renamePrefab(prefab.id, v));
        const rows: HTMLElement[] = [
            row('Prefab', name.el),
            row('Instances', h('div', { class: 'readonly', text: `${count} in the scene` })),
            row('Shows', h('div', { class: 'readonly', text: prefab.useModel ? `Model: ${model?.name ?? 'missing'}` : `Greybox template, ${prefab.nodes.length} part${prefab.nodes.length === 1 ? '' : 's'}` })),
        ];
        const actions = h('div', { class: 'inline wrap' });
        if (!prefab.useModel) actions.appendChild(button('Edit Prefab', () => editor.editPrefab(node.id), 'small', 'prefab'));
        actions.appendChild(button(model ? 'New Model Version' : 'Replace with Model', () => void editor.replacePrefabModel(prefab.id), 'small', 'model'));
        if (model) actions.appendChild(button(prefab.useModel ? 'Show Template' : 'Show Model', () => editor.usePrefabModel(prefab.id, !prefab.useModel), 'small'));
        rows.push(row('', actions));
        rows.push(h('div', { class: 'muted small pad', text: 'Every instance follows the prefab. A .glb imported with Replace with Model takes the place of the greybox template in all of them.' }));
        const menu = iconButton('dots', 'Prefab options', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                [
                    { label: 'Select All Instances', action: () => this.store.select(editor.instancesOf(prefab.id).map((n) => n.id)) },
                    { label: 'Place Another', icon: 'plus', action: () => editor.placePrefab(prefab.id) },
                    { separator: true },
                    { label: 'Unpack This Instance', action: () => editor.unpackInstance(node.id) },
                    { label: 'Delete Prefab', icon: 'trash', action: () => void editor.deletePrefab(prefab.id) },
                ],
                r.left - 170,
                r.bottom + 4,
            );
        });
        return section('prefab', 'Prefab', 'prefab', rows, [menu]);
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
            case 'cone':
                param('Radius', 'radius', 0.01, 0.001);
                param('Height', 'height', 0.01, 0.001);
                param('Segments', 'segments', 0.25, 3, true);
                break;
            case 'torus':
                param('Radius', 'radius', 0.01, 0.001);
                param('Tube', 'tube', 0.005, 0.001);
                param('Segments', 'segments', 0.25, 3, true);
                break;
            case 'ramp':
                param('Width', 'width', 0.01, 0.001);
                param('Height', 'height', 0.01, 0.001);
                param('Length', 'depth', 0.01, 0.001);
                break;
            case 'stairs':
                param('Width', 'width', 0.01, 0.001);
                param('Height', 'height', 0.01, 0.001);
                param('Length', 'depth', 0.01, 0.001);
                param('Steps', 'steps', 0.1, 1, true);
                break;
            case 'capsule':
                param('Radius', 'radius', 0.01, 0.001);
                param('Height', 'height', 0.01, 0.001);
                param('Segments', 'segments', 0.25, 6, true);
                break;
        }
        if (g.type === 'ramp' || g.type === 'stairs') {
            const hint = h('div', { class: 'readonly' });
            const update = () => {
                const cur = this.node.mesh?.geometry as any;
                if (!cur || (cur.type !== 'ramp' && cur.type !== 'stairs')) return;
                const slope = (Math.atan2(cur.height, cur.depth) * 180) / Math.PI;
                hint.textContent = cur.type === 'stairs'
                    ? `Step ${(cur.height / Math.max(1, cur.steps)).toFixed(2)} m high, ${(cur.depth / Math.max(1, cur.steps)).toFixed(2)} m deep, ${slope.toFixed(0)} deg`
                    : `Slope ${slope.toFixed(1)} deg, rising toward -Z`;
            };
            update();
            this.watch(update);
            rows.push(row('', hint));
        }
        if (g.type === 'cone') {
            const hint = h('div', { class: 'readonly' });
            const update = () => {
                const cur = this.node.mesh?.geometry;
                if (cur?.type !== 'cone') return;
                const seg = Math.max(3, Math.round(cur.segments));
                hint.textContent = seg <= 8
                    ? `${seg} flat sides${seg === 4 ? `: a pyramid ${(cur.radius * Math.SQRT2).toFixed(2)} m wide` : ''}`
                    : 'Round; 8 segments or fewer give flat sides (4: a pyramid)';
            };
            update();
            this.watch(update);
            rows.push(row('', hint));
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
            this.hooks<MaterialDoc[K]>(
                label,
                has,
                (n, v) => {
                    (n.mesh!.material as any)[key] = v;
                },
                (n) => n.mesh!.material[key],
            );
        const rows: HTMLElement[] = [];
        const slot = m.slot ? this.store.doc.design.materials.find((x) => x.id === m.slot) : undefined;
        if (slot) {
            // The slot rewrites this material whenever it changes: edit it there.
            rows.push(
                h(
                    'div',
                    { class: 'design-note' },
                    icon('sliders', 14),
                    h('span', { text: `Follows the material slot ${slot.name}. Change the slot in the Design tab; edits here are replaced when the slot changes.` }),
                    button('Unlink', () => unassignSlot(this.store, this.store.selection), 'small'),
                ),
            );
        }
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

        rows.push(...this.componentRows('material', ['color', 'opacity', 'alphaMode', ...(m.alphaMode === 'mask' ? ['alphaCutoff'] : [])]));
        // Metallic and roughness are PBR; emission is for lit surfaces.
        if (lit) rows.push(...this.componentRows('material', [...(m.type !== 'lambert' ? ['metallic', 'roughness'] : []), 'emissive', 'emissiveIntensity']));
        rows.push(...this.componentRows('material', ['doubleSide']));

        const textures = this.store.doc.assets.filter((a) => a.kind === 'texture');
        const map = this.textureSelect(m.map ?? null, textures, (v) => this.editor.applyTexture(v), 'color');
        rows.push(row('Texture', map.el, 'Base color map'), ...this.componentRows('material', ['tiling', 'offset']));

        // PBR extras of the lit material.
        const maps: { set(md: MaterialDoc): void }[] = [];
        if (pbr) {
            rows.push(h('div', { class: 'group-label', text: 'Maps' }));
            const mapRow = (key: 'normalMap' | 'metalRoughMap' | 'aoMap' | 'emissiveMap', label: string, hint: string) => {
                const f = this.textureSelect((m[key] as string | null | undefined) ?? null, textures, (v) => set(key, label).commit!(v), MAP_ROLES[key]);
                maps.push({ set: (md) => f.set((md[key] as string | null | undefined) ?? null) });
                rows.push(row(label, f.el, hint));
            };
            mapRow('normalMap', 'Normal Map', 'Tangent space normal map');
            rows.push(...this.componentRows('material', ['normalScale']));
            mapRow('metalRoughMap', 'Metal / Rough', 'glTF metallic-roughness map: roughness in green, metallic in blue. Multiplies the sliders.');
            mapRow('aoMap', 'Occlusion', 'Ambient occlusion map (red channel)');
            mapRow('emissiveMap', 'Emission Map', 'Multiplied by the emissive color');
            rows.push(h('div', { class: 'group-label', text: 'Clear Coat' }), ...this.componentRows('material', ['clearcoat', 'clearcoatRoughness']));
            rows.push(h('div', { class: 'group-label', text: 'Transmission' }), ...this.componentRows('material', ['transmission', 'ior', 'thickness', 'attenuationColor', 'attenuationDistance']));
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
            map.set(mat.map ?? null);
            for (const f of maps) f.set(mat);
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
    private textureSelect(value: string | null, textures: AssetMeta[], onPick: (id: string | null) => void, role: TextureRole): { el: HTMLElement; set(v: string | null): void } {
        let current = value;
        const options = iconButton('sliders', 'Compression for games', (e) => {
            if (current) openTextureOptions(this.editor, e.currentTarget as HTMLElement, current, role);
        });
        options.disabled = !current;
        const select = new SelectField<string>([{ value: '', label: 'None' }, ...textures.map((t) => ({ value: t.id, label: t.name }))], value ?? '', (v) => {
            current = v || null;
            options.disabled = !current;
            onPick(current);
        });
        const el = h('div', { class: 'inline' }, select.el, options, iconButton('upload', 'Import image', () => this.editor.importTextureDialog()));
        return {
            el,
            set: (v) => {
                current = v;
                options.disabled = !v;
                select.set(v ?? '');
            },
        };
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
        const type = new SelectField(LIGHT_OPTIONS, l.type, (v) => this.hooks<LightType>('Light Type', has, (n, t) => {
            if (n.light!.type !== t) n.light = { ...defaultLight(t), color: n.light!.color };
        }).commit!(v));
        this.watch(() => this.node.light && type.set(this.node.light.type));
        // Range and radius belong to point and spot lights, the cones to spot lights: lights of this type get them.
        const own = [...(l.type !== 'directional' ? ['range', 'radius'] : []), ...(l.type === 'spot' ? ['outerAngle', 'innerAngle'] : [])];
        const rows = [row('Type', type.el), ...this.componentRows('light', ['color', 'intensity', 'castShadow']), ...this.componentRows('light', own, (n) => n.light?.type === l.type)];
        // Its shadow map: size and redraws for every light; what it covers for directional ones.
        if (l.castShadow) {
            const dir = l.type === 'directional';
            const shadow = ['resolution', 'update', ...(dir ? ['coverage', 'range'] : []), ...(dir && l.shadow?.coverage === 'cascades' ? ['cascades'] : [])];
            rows.push(...this.componentRows('lightShadow', shadow, (n) => !!n.light?.castShadow && (!dir || n.light.type === 'directional')));
        }
        const remove = iconButton('trash', 'Remove light', () => this.hooks<null>('Remove Light', has, (n) => delete n.light).commit!(null));
        return section('light', 'Light', l.type === 'directional' ? 'sun' : l.type === 'point' ? 'bulb' : 'spot', rows, [remove]);
    }

    // ------------------------------------------------------------ particles

    private particlesSection(): HTMLElement {
        const has: Filter = (n) => !!n.particles;
        const p = this.node.particles!;
        const preset = h('button', { class: 'btn small', attrs: { type: 'button' } }, icon('sparkle', 14), h('span', { text: 'Preset...' }));
        preset.addEventListener('click', () => {
            const r = preset.getBoundingClientRect();
            showMenu(
                PARTICLE_PRESETS.map((pr) => ({
                    label: pr.label,
                    icon: 'sparkle',
                    action: () => this.hooks<null>('Particle Preset', has, (n) => (n.particles = { ...presetParticles(pr.id), texture: n.particles!.texture })).commit!(null),
                })),
                r.left,
                r.bottom + 4,
            );
        });
        const textures = this.store.doc.assets.filter((a) => a.kind === 'texture');
        const tex = new SelectField<string>([{ value: '', label: 'Soft dot' }, ...textures.map((a) => ({ value: a.id, label: a.name }))], p.texture ?? '', (v) =>
            this.hooks<string | null>('Particle Texture', has, (n, t) => (n.particles!.texture = t)).commit!(v || null));
        this.watch(() => this.node.particles && tex.set(this.node.particles.texture ?? ''));
        const rows = [
            row('', h('div', { class: 'inline' }, preset, h('span', { class: 'muted small', text: `up to ${particleCount(p)} alive` }))),
            ...this.componentRows('particles', ['rate', 'max', 'life', 'size', 'sizeEnd', 'shape', p.shape === 'box' ? 'box' : 'radius', 'velocityMin', 'velocityMax', 'gravity']),
            ...this.componentRows('particles', ['colorStart', 'colorEnd', 'alphaStart', 'alphaEnd', 'spin', 'blend']),
            row('Sprite', tex.el, 'Texture of each particle'),
            ...this.componentRows('particles', ['local', 'prewarm']),
        ];
        const remove = iconButton('trash', 'Remove particles', () => this.hooks<null>('Remove Particles', has, (n) => delete n.particles).commit!(null));
        return section('particles', 'Particles', 'sparkle', rows, [remove]);
    }

    // --------------------------------------------------------------- camera

    private cameraSection(): HTMLElement {
        const has: Filter = (n) => !!n.camera;
        const main = new CheckboxField(this.node.camera!.main, (v) => {
            const id = this.node.id;
            this.store.commit('Main Camera', (doc) => {
                for (const n of doc.nodes) if (n.camera) n.camera.main = v ? n.id === id : n.id === id ? false : n.camera.main;
            });
        }, 'Used by Play');
        this.watch(() => this.node.camera && main.set(this.node.camera.main));
        const actions = h(
            'div',
            { class: 'inline' },
            button('Align to View', () => this.editor.alignCameraToView(), 'small', 'focus'),
            button('Look Through', () => this.editor.viewThroughCamera(this.node.id), 'small', 'camera'),
        );
        const remove = iconButton('trash', 'Remove camera', () => this.hooks<null>('Remove Camera', has, (n) => delete n.camera).commit!(null));
        return section('camera', 'Camera', 'camera', [row('Main', main.el), ...this.componentRows('camera', ['fov', 'near', 'far']), row('', actions)], [remove]);
    }

    // ------------------------------------------------------------ character

    private characterSection(): HTMLElement {
        const has: Filter = (n) => !!n.character;
        const specs = this.store.doc.design.specs;
        const fromBrief = button('Body from the Brief', () => this.hooks<null>('Character Size from the Brief', has, (n) => {
            const d = defaultCharacter(specs);
            Object.assign(n.character!, { height: d.height, radius: d.radius, eyeHeight: d.eyeHeight, stepHeight: d.stepHeight, maxSlope: d.maxSlope });
        }).commit!(null), 'small', 'walk');
        const remove = iconButton('trash', 'Remove character', () => this.hooks<null>('Remove Character', has, (n) => {
            delete n.character;
            delete n.player;
        }).commit!(null));
        return section('character', 'Character', 'walk', [
            h('div', { class: 'muted small pad', text: 'A body that walks the level in Play. The player controls it with a Player Controller; for an NPC, a behavior tree walks it with Move To, or a script with this.character.' }),
            ...this.componentRows('character', ['speed', 'runSpeed', 'jump', 'gravity', 'height', 'radius', 'eyeHeight', 'stepHeight', 'maxSlope', 'collide']),
            row('', fromBrief, `Height ${specs.playerHeight} m, radius ${specs.playerRadius} m, eyes at ${specs.eyeHeight} m, steps up to ${specs.stepHeight} m, slopes up to ${specs.maxSlope}°`),
        ], [remove]);
    }

    private playerSection(): HTMLElement {
        const has: Filter = (n) => !!n.player;
        const third = this.node.player!.view === 'third';
        const remove = iconButton('trash', 'Remove player controller', () => this.hooks<null>('Remove Player Controller', has, (n) => delete n.player).commit!(null));
        return section('player', 'Player Controller', 'play', [
            h('div', { class: 'muted small pad', text: 'The player controls this character in Play: WASD or the arrow keys move, Shift runs, Space jumps, a drag or Q / E turns the view and the wheel zooms. Touch screens get a joystick, a jump button, a finger to look and a pinch to zoom.' }),
            ...this.componentRows('player', ['view', ...(third ? ['distance'] : []), 'lookSpeed', 'invertY']),
        ], [remove]);
    }

    private physicsSection(): HTMLElement {
        const has: Filter = (n) => !!n.body;
        const dynamic = this.node.body!.type === 'dynamic';
        const remove = iconButton('trash', 'Remove physics body', () => this.hooks<null>('Remove Physics Body', has, (n) => delete n.body).commit!(null));
        return section('body', 'Physics Body', 'physics', [
            h('div', { class: 'muted small pad', text: 'In Play a dynamic body falls, collides and bounces; a kinematic one follows its object as scripts move it and pushes dynamic bodies; a fixed one stays put. Meshes without a body are fixed too, and characters push dynamic bodies. Scripts use this.body and onCollisionEnter / onTriggerEnter.' }),
            ...this.componentRows('body', ['type', 'shape', ...(dynamic ? ['mass'] : []), 'friction', 'bounce', ...(dynamic ? ['drag', 'angularDrag', 'gravity', 'lockRotation', 'fast'] : []), 'sensor']),
        ], [remove]);
    }

    // ------------------------------------------- mirror, grass, instancing

    private mirrorSection(): HTMLElement {
        const has: Filter = (n) => !!n.mirror;
        const shader = this.node.mesh?.material.type === 'shader';
        const remove = iconButton('trash', 'Remove mirror', () => this.hooks<null>('Remove Mirror', has, (n) => delete n.mirror).commit!(null));
        return section('mirror', 'Mirror', 'mirror', [
            h('div', {
                class: 'muted small pad',
                text: shader
                    ? 'Its material shader reads the reflection with mirrorColor(offset), as the Water template does (waves that move it, a fresnel term that blends it).'
                    : 'The mesh shows the scene reflected in the plane through its top (a plane\'s face, a box\'s top), tinted by its material\'s color. For water, give it the Water material shader. The scene is drawn again for it while the camera is in front.',
            }),
            ...this.componentRows('mirror', ['resolution']),
        ], [remove]);
    }

    private grassSection(): HTMLElement {
        const has: Filter = (n) => !!n.grass;
        const g = this.node.grass!;
        const self = this.node.id;
        // What the blades can stand on: objects with a mesh, a model, a terrain or children.
        const grounds = this.store.doc.nodes.filter((n) => (n.id !== self || n.terrain) && !n.prefabChild && (n.mesh || n.model || n.terrain || this.store.children(n.id).length));
        const ground = new SelectField<string>([{ value: '', label: 'None (flat)' }, ...grounds.map((n) => ({ value: n.id, label: n.name }))], g.ground ?? '', (v) =>
            this.hooks<string | null>('Grass Ground', has, (n, x) => (n.grass!.ground = x)).commit!(v || null));
        const textures = this.store.doc.assets.filter((a) => a.kind === 'texture');
        const textureField = (key: 'texture' | 'windMap', none: string, label: string) => {
            const f = new SelectField<string>([{ value: '', label: none }, ...textures.map((a) => ({ value: a.id, label: a.name }))], g[key] ?? '', (v) =>
                this.hooks<string | null>(label, has, (n, x) => (n.grass![key] = x)).commit!(v || null));
            this.watch(() => this.node.grass && f.set(this.node.grass[key] ?? ''));
            return f;
        };
        const blade = textureField('texture', 'Plain', 'Grass Texture');
        const gusts = textureField('windMap', 'Built-in noise', 'Grass Gusts');
        this.watch(() => this.node.grass && ground.set(this.node.grass.ground ?? ''));
        const remove = iconButton('trash', 'Remove grass', () => this.hooks<null>('Remove Grass', has, (n) => delete n.grass).commit!(null));
        return section('grass', 'Grass', 'grass', [
            h('div', { class: 'muted small pad', text: 'Blades over the area around the object, all in one draw, bent by gusts of wind. Each stands on the ground object below it, so the field follows any terrain; without a ground it is flat at the object\'s height.' }),
            ...this.componentRows('grass', ['count', 'size']),
            row('Ground', ground.el, 'Terrain, floor or a group of them; blades outside it are left out'),
            ...this.componentRows('grass', ['height', 'width', 'heights', 'widths', 'sizes', 'maxSlope', 'waterGap', 'gaps']),
            h('div', { class: 'muted small pad', text: 'Shapes, by their shares:' }),
            ...this.fieldRows(inner(Grass.shape.shapes) as z.ZodObject, (n: NodeDoc) => n.grass?.shapes, ['blade', 'leaf', 'needle']),
            ...this.componentRows('grass', ['shapeSpread', 'curvature', 'patchSize', 'bottomColor', 'topColor', 'rootBlend', 'dryness', 'wind', 'windSpeed', 'windDirection']),
            row('Texture', blade.el, 'Blade texture: alpha below 0.3 is cut out'),
            row('Gust Map', gusts.el, 'Red and green make the gusts, a pixel per meter'),
            ...this.componentRows('grass', ['distance', 'castShadow']),
        ], [remove]);
    }

    private rainSection(): HTMLElement {
        const has: Filter = (n) => !!n.rain;
        const r = this.node.rain!;
        const self = this.node.id;
        const pick = (key: 'shelter' | 'light', none: string, label: string, list: NodeDoc[]) => {
            const f = new SelectField<string>([{ value: '', label: none }, ...list.map((n) => ({ value: n.id, label: n.name }))], r[key] ?? '', (v) =>
                this.hooks<string | null>(label, has, (n, x) => (n.rain![key] = x)).commit!(v || null));
            this.watch(() => this.node.rain && f.set(this.node.rain[key] ?? ''));
            return f;
        };
        const shelter = pick('shelter', 'None', 'Rain Shelter', this.store.doc.nodes.filter((n) => n.id !== self && !n.prefabChild && (n.mesh || n.model || this.store.children(n.id).length)));
        const light = pick('light', 'None', 'Rain Light', this.store.doc.nodes.filter((n) => !!n.light && n.light.type !== 'directional'));
        const remove = iconButton('trash', 'Remove rain', () => this.hooks<null>('Remove Rain', has, (n) => delete n.rain).commit!(null));
        return section('rain', 'Rain', 'rain', [
            h('div', { class: 'muted small pad', text: 'Drops at real places in a box around the object, drawn by one shader: they keep their size with distance, stop at the bottom and lean with the wind. Keep the box in the open air, its bottom on the ground; it costs by the share of the screen it covers and by its spacing.' }),
            ...this.componentRows('rain', ['size', 'amount', 'spacing', 'dropWidth', 'streak', 'speed', 'wind', 'density', 'brightness', 'color', 'nearFade']),
            row('Shelter', shelter.el, 'Its box stays dry: an awning, a porch roof'),
            row('Light', light.el, 'Drops near it catch its color'),
            ...this.componentRows('rain', ['lightGain']),
        ], [remove]);
    }

    private terrainSection(): HTMLElement {
        const has: Filter = (n) => !!n.terrain;
        const id = this.node.id;
        const shape = h('div', { class: 'readonly' });
        const showShape = () => {
            const view = this.editor.sync.terrainView(id);
            if (!view) {
                shape.textContent = '';
                return;
            }
            const { map, frame: f } = view;
            const [lo, hi] = extremesOf(map);
            shape.textContent = `${meters(f.y + lo * f.height)} to ${meters(f.y + hi * f.height)} m`;
            shape.title = `${map.width} x ${map.height} samples, ${meters(f.sizeX / (map.width - 1))} m apart`;
        };
        showShape();
        this.watch(showShape);
        const heights = h('div', { class: 'readonly' });
        this.watch(() => {
            const file = this.store.doc.assets.find((a) => a.id === this.node.terrain?.heightmap);
            heights.textContent = file ? file.name : 'None (flat)';
        });
        heights.textContent = this.store.doc.assets.find((a) => a.id === this.node.terrain!.heightmap)?.name ?? 'None (flat)';
        const load = iconButton('upload', 'Import a heightmap (a 16-bit grayscale PNG, or raw 16-bit .r16 / .raw)', () => void this.editor.importHeightmapDialog(id));
        const remove = iconButton('trash', 'Remove terrain', () => this.hooks<null>('Remove Terrain', has, (n) => delete n.terrain).commit!(null));
        return section('terrain', 'Terrain', 'terrain', [
            h('div', { class: 'muted small pad', text: 'Ground from a heightmap over the area around the object, drawn in chunks that get coarser far away. In Play characters and bodies stand on it; grass and scatters grow on it. Choose a brush and drag on it in the view to shape or paint it.' }),
            row('Ground', shape, 'Lowest and highest ground'),
            row('Heightmap', h('div', { class: 'inline grow' }, heights, load), 'Each sculpt stroke saves the heights as a new file (one undo step)'),
            ...this.componentRows('terrain', ['size', 'height', 'detail', 'blending', 'variation', 'wetShore', 'puddles', 'relief', 'compress', 'collide', 'castShadow']),
            ...this.brushRows(),
            ...this.terrainLayerRows(),
        ], [remove]);
    }

    /** The terrain brush: its tool, size and strength (not part of the document). */
    private brushRows(): HTMLElement[] {
        const ed = this.editor;
        const tools = h('div', { class: 'brush-tools', attrs: { role: 'radiogroup', 'aria-label': 'Brush' } });
        const buttons = BRUSH_TOOLS.map((t) => {
            const b = h('button', { class: 'seg-btn', text: t.label, title: t.hint, attrs: { type: 'button', role: 'radio' } });
            b.addEventListener('click', () => ed.setBrush({ tool: ed.brush.tool === t.value ? null : t.value }));
            tools.append(b);
            return { b, value: t.value };
        });
        const radius = new SliderField({ value: ed.brush.radius, min: 0.5, max: 100, step: 0.5, precision: 1, input: (v) => ed.setBrush({ radius: v }), commit: (v) => ed.setBrush({ radius: Math.max(0.2, v) }) });
        const strength = new SliderField({ value: ed.brush.strength, min: 0.05, max: 1, step: 0.05, precision: 2, input: (v) => ed.setBrush({ strength: v }), commit: (v) => ed.setBrush({ strength: Math.min(1, Math.max(0.01, v)) }) });
        const layers = this.node.terrain!.layers;
        const layer = new SelectField<string>(layers.map((l, i) => ({ value: String(i), label: `${i + 1}: ${this.layerName(l.slot, l.albedo)}` })), String(ed.brush.layer), (v) => ed.setBrush({ layer: Number(v) }));
        const layerRow = row('Paint Layer', layer.el, 'The layer the brush paints');
        const hint = h('div', { class: 'muted small pad' });
        this.brushSync = () => {
            const tool = ed.brush.tool;
            for (const { b, value } of buttons) {
                b.classList.toggle('on', value === tool);
                b.setAttribute('aria-checked', String(value === tool));
            }
            radius.set(ed.brush.radius);
            strength.set(ed.brush.strength);
            if (ed.brush.layer >= layers.length && layers.length) ed.brush.layer = layers.length - 1;
            layer.set(String(ed.brush.layer));
            layerRow.hidden = tool !== 'paint';
            hint.textContent = tool
                ? `${BRUSH_TOOLS.find((t) => t.value === tool)!.hint}: drag on the terrain in the view. Alt or the right button still turn the view; click the tool again to stop.`
                : 'Choose a tool, then drag on the terrain in the view to shape or paint it.';
        };
        this.brushSync();
        return [
            h('div', { class: 'group-label', text: 'Brush' }),
            tools,
            row('Radius', radius.el, 'Meters from the middle of the brush to its edge'),
            row('Strength', strength.el, 'How fast it works'),
            layerRow,
            hint,
        ];
    }

    /** A layer's name: its slot's, else its color map's. */
    private layerName(slot: string | null, albedo: string | null): string {
        const doc = this.store.doc;
        return (slot && doc.design.materials.find((m) => m.id === slot)?.name) || (albedo && doc.assets.find((a) => a.id === albedo)?.name) || 'Plain';
    }

    /** A terrain's layers: each a material slot (or its own maps) and where it shows. */
    private terrainLayerRows(): HTMLElement[] {
        const t = this.node.terrain!;
        const slots = this.store.doc.design.materials;
        const textures = this.store.doc.assets.filter((a) => a.kind === 'texture');
        const out: HTMLElement[] = [h('div', { class: 'group-label', text: 'Layers' })];
        if (!t.layers.length) out.push(h('div', { class: 'muted small pad', text: 'No layers: the ground is plain gray. Add one for its surface (the first covers everything).' }));
        t.layers.forEach((l, i) => {
            const get = (n: NodeDoc) => n.terrain?.layers[i];
            const has: Filter = (n) => !!get(n);
            const slot = new SelectField<string>([{ value: '', label: 'Own maps' }, ...slots.map((m) => ({ value: m.id, label: m.name }))], l.slot ?? '', (v) =>
                this.hooks<string>('Layer Material', has, (n, x) => {
                    const layer = get(n)!;
                    const found = x ? this.store.doc.design.materials.find((m) => m.id === x) : undefined;
                    if (found) layerFromSlot(layer, found);
                    else layer.slot = null;
                }).commit!(v));
            this.watch(() => {
                const cur = get(this.node);
                if (cur) slot.set(cur.slot ?? '');
            });
            const up = i > 0
                ? iconButton('arrowUp', 'Move before the layer above (drawn under it)', () => this.hooks<null>('Move Layer', has, (n) => {
                    const list = n.terrain!.layers;
                    [list[i - 1], list[i]] = [list[i], list[i - 1]];
                }).commit!(null))
                : null;
            const drop = iconButton('trash', 'Remove layer', () => this.hooks<null>('Remove Layer', has, (n) => void n.terrain!.layers.splice(i, 1)).commit!(null));
            out.push(h('div', { class: 'terrain-layer-head' }, h('span', { text: i === 0 ? `Layer 1: everywhere` : `Layer ${i + 1}` }), up, drop));
            out.push(row('Material', slot.el, 'A material slot: the layer shows its swatch at its tile size and follows it'));
            if (!l.slot) {
                const map = (key: 'albedo' | 'normal', label: string) => {
                    const f = new SelectField<string>([{ value: '', label: 'None' }, ...textures.map((a) => ({ value: a.id, label: a.name }))], l[key] ?? '', (v) =>
                        this.hooks<string | null>(label, has, (n, x) => (get(n)![key] = x)).commit!(v || null));
                    this.watch(() => {
                        const cur = get(this.node);
                        if (cur) f.set(cur[key] ?? '');
                    });
                    return f;
                };
                out.push(row('Color Map', map('albedo', 'Layer Color Map').el), row('Normal Map', map('normal', 'Layer Normal Map').el));
                out.push(...this.fieldRows(TerrainLayer, get as Getter, ['tile', 'color', 'roughness']));
            }
            if (i > 0) out.push(...this.fieldRows(TerrainLayer, get as Getter, ['height', 'slope', 'heightBlend', 'slopeBlend', 'onlyPainted']));
            out.push(...this.fieldRows(TerrainLayer, get as Getter, ['grass', 'debris']));
        });
        if (t.layers.length < 4) {
            out.push(h('div', { class: 'design-actions' }, button('Add Layer', () => this.hooks<null>('Add Layer', (n) => !!n.terrain && n.terrain.layers.length < 4, (n) => {
                const layer = defaults(TerrainLayer);
                // A later layer starts on the steep slopes, where rock goes.
                if (n.terrain!.layers.length) layer.slope = [35, 90];
                const first = this.store.doc.design.materials[0];
                if (first) layerFromSlot(layer, first);
                n.terrain!.layers.push(layer);
            }).commit!(null), 'small', 'plus')));
        }
        return out;
    }

    private scatterSection(): HTMLElement {
        const has: Filter = (n) => !!n.scatter;
        const s = this.node.scatter!;
        const self = this.node.id;
        const doc = this.store.doc;
        const placed = h('div', { class: 'readonly' });
        const showPlaced = () => {
            const cur = this.node.scatter;
            if (!cur) return;
            const copies = this.editor.sync.scatterPlacements(self).length;
            const solids = this.editor.sync.scatterSolids().find((x) => x.id === self)?.solids.length ?? 0;
            placed.textContent = !cur.sources.some((x) => x.model || x.tree) ? 'Add a model or a tree to place' : `${copies} of ${cur.count}${solids ? `, ${solids} solid` : ''}`;
        };
        showPlaced();
        this.watch(showPlaced);
        const models = doc.assets.filter((a) => a.kind === 'model');
        const sources: HTMLElement[] = [];
        s.sources.forEach((src, i) => {
            const get = (n: NodeDoc) => n.scatter?.sources[i];
            const hasSource: Filter = (n) => !!get(n);
            const model = new SelectField<string>([
                { value: '', label: 'None' },
                ...TREE_SPECIES.map((sp) => ({ value: TREE_CHOICE + sp, label: `${SPECIES_NAME[sp]} (tree)` })),
                ...models.map((a) => ({ value: a.id, label: a.name })),
            ], sourceChoice(src), (v) => this.hooks<string>('Scatter Model', hasSource, (n, x) => chooseSource(n, get(n)!, x)).commit!(v));
            this.watch(() => {
                const cur = get(this.node);
                if (cur) model.set(sourceChoice(cur));
            });
            const drop = iconButton('trash', 'Remove this source', () => this.hooks<null>('Remove Scatter Model', hasSource, (n) => void n.scatter!.sources.splice(i, 1)).commit!(null));
            sources.push(src.tree
                ? row(`Tree ${i + 1}`, h('div', { class: 'inline grow' }, model.el, drop), 'A tree grown from rules: each copy is one of a few variants of it, as tall as its height times its scale')
                : row(`Model ${i + 1}`, h('div', { class: 'inline grow' }, model.el, drop), 'A model to place: a tree, rock or bush (a set of pieces side by side gives each copy one piece), or a tree grown from rules'));
            sources.push(...this.fieldRows(ScatterSource, get as Getter, ['weight', 'scale', 'solid']));
            if (src.tree) sources.push(...this.fieldRows(Tree, (n) => get(n)?.tree, SCATTER_TREE_ROWS));
        });
        if (s.sources.length < 8) {
            const add = button('Add Model', () => this.hooks<null>('Add Scatter Model', (n) => !!n.scatter && n.scatter.sources.length < 8, (n) => {
                n.scatter!.sources.push({ ...defaults(ScatterSource), model: models.find((a) => !n.scatter!.sources.some((x) => x.model === a.id))?.id ?? models[0]?.id ?? null });
            }).commit!(null), 'small', 'plus');
            const tree = button('Add Tree', () => this.hooks<null>('Add Scatter Tree', (n) => !!n.scatter && n.scatter.sources.length < 8, (n) => {
                const src = { ...defaults(ScatterSource) };
                n.scatter!.sources.push(src);
                // The species no source grows yet.
                chooseSource(n, src, TREE_CHOICE + (TREE_SPECIES.find((sp) => !n.scatter!.sources.some((x) => x.tree?.species === sp)) ?? 'oak'));
            }).commit!(null), 'small', 'plant');
            tree.title = 'A tree grown from rules: oak, birch or spruce';
            sources.push(h('div', { class: 'design-actions' }, add, tree));
        }
        // What copies stand on, and what they keep clear of: objects with a mesh, a model, a terrain or children.
        const solid = doc.nodes.filter((n) => (n.id !== self || n.terrain) && !n.prefabChild && (n.mesh || n.model || n.terrain || this.store.children(n.id).length));
        const ground = new SelectField<string>([{ value: '', label: 'None (flat)' }, ...solid.map((n) => ({ value: n.id, label: n.name }))], s.ground ?? '', (v) =>
            this.hooks<string | null>('Scatter Ground', has, (n, x) => (n.scatter!.ground = x)).commit!(v || null));
        this.watch(() => this.node.scatter && ground.set(this.node.scatter.ground ?? ''));
        const avoided = h('div', { class: 'chips' });
        for (const aid of s.avoid) {
            const name = this.store.node(aid)?.name ?? aid;
            avoided.append(h('button', {
                class: 'chip',
                text: `${name} ×`,
                title: `Stop keeping clear of ${name}`,
                attrs: { type: 'button' },
                on: { click: () => this.hooks<null>('Scatter Avoid', has, (n) => (n.scatter!.avoid = n.scatter!.avoid.filter((x) => x !== aid))).commit!(null) },
            }));
        }
        // What they can keep clear of: those objects, and trees.
        const avoidable = doc.nodes.filter((n) => n.id !== self && !n.terrain && !n.prefabChild && !s.avoid.includes(n.id) && (n.mesh || n.model || n.tree || this.store.children(n.id).length));
        const addAvoid = new SelectField<string>([{ value: '', label: 'Keep clear of...' }, ...avoidable.map((n) => ({ value: n.id, label: n.name }))], '', (v) => {
            if (v) this.hooks<string>('Scatter Avoid', has, (n, x) => void (n.scatter!.avoid.includes(x) || n.scatter!.avoid.push(x))).commit!(v);
        });
        const reseed = button('Reseed', () => this.hooks<number>('Reseed Scatter', has, (n, x) => (n.scatter!.seed = x)).commit!(Math.floor(Math.random() * 999999)), 'small', 'refresh');
        reseed.title = 'Place the copies anew';
        const bake = button('Make Objects', () => {
            if (!this.editor.bakeScatter(self)) toast('The scatter has no copies yet (or its models are still loading).', 'info');
        }, 'small', 'layers');
        bake.title = 'Turn the copies into objects of their own under an instanced group, to edit one by one (the scatter goes). Trees become tree objects, each drawn on its own: keep forests as scatters';
        const remove = iconButton('trash', 'Remove scatter', () => this.hooks<null>('Remove Scatter', has, (n) => delete n.scatter).commit!(null));
        return section('scatter', 'Scatter', 'scatter', [
            h('div', { class: 'muted small pad', text: 'Copies of models or trees spread over the area around the object by rules, drawn instanced by parts of the area. Only the rules are saved: the copies are placed again from them whenever they, the ground or what to avoid change.' }),
            row('Placed', placed, 'Copies placed of those asked, and how many stop characters in Play'),
            ...sources,
            ...this.componentRows('scatter', ['size', 'count', 'spacing', 'seed']),
            row('Ground', ground.el, 'What the copies stand on: a terrain, a floor or a group of them'),
            ...this.componentRows('scatter', ['height', 'slope', 'layer', 'clusters', 'clusterSize']),
            row('Avoid', h('div', {}, avoided, addAvoid.el), 'Objects whose ground area stays clear: buildings, paths, the play area'),
            ...this.componentRows('scatter', ['margin', 'align', 'tilt', 'sink', 'bury', 'soil', 'moss', 'mossColor', 'vary', 'sway', 'distance', 'castShadow']),
            h('div', { class: 'design-actions' }, reseed, bake),
        ], [remove]);
    }

    private treeSection(): HTMLElement {
        const has: Filter = (n) => !!n.tree;
        const id = this.node.id;
        const drawn = h('div', { class: 'readonly' });
        const showDrawn = () => {
            const tris = this.editor.sync.treeView(id)?.levelTriangles();
            const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
            drawn.textContent = tris ? tris.map(k).join(' · ') : this.node.visible ? 'Growing...' : 'Hidden';
        };
        showDrawn();
        this.watch(showDrawn);
        const reseed = button('Reseed', () => this.hooks<number>('Reseed Tree', has, (n, x) => (n.tree!.seed = x)).commit!(Math.floor(Math.random() * 999999)), 'small', 'refresh');
        reseed.title = 'Grow another tree of the species';
        const forest = button('Make Forest', () => this.editor.forestFrom(id), 'small', 'scatter');
        forest.title = 'A scatter of trees like this one around it (this tree stays)';
        const remove = iconButton('trash', 'Remove tree', () => this.hooks<null>('Remove Tree', has, (n) => delete n.tree).commit!(null));
        return section('tree', 'Tree', 'plant', [
            h('div', { class: 'muted small pad', text: 'A tree grown from rules: trunk, branches and leaves from the species and the seed, in three levels of detail that take over with distance. The wind of the weather sways it. Scale it with the object\'s scale; for a forest, use a scatter of trees.' }),
            row('Triangles', drawn, 'Triangles of each level of detail: near, midway and far'),
            ...this.componentRows('tree', ['species', 'seed', 'height', 'width', 'trunk', 'branches', 'leaves', 'leafSize', 'gnarl']),
            ...this.componentRows('tree', ['autumn', 'leafTint', 'barkTint', 'translucency', 'wind', 'castShadow', 'solid']),
            h('div', { class: 'design-actions' }, reseed, forest),
        ], [remove]);
    }

    private instancingSection(): HTMLElement {
        const has: Filter = (n) => !!n.instancing;
        const drawn = h('div', { class: 'readonly' });
        const refresh = () => {
            const s = this.editor.sync.instancingOf(this.node.id);
            drawn.textContent = s ? `${s.meshes} mesh${s.meshes === 1 ? '' : 'es'} in ${s.draws} draw call${s.draws === 1 ? '' : 's'}` : '';
        };
        refresh();
        this.watch(refresh);
        const remove = iconButton('trash', 'Remove instancing', () => this.hooks<null>('Remove Instancing', has, (n) => delete n.instancing).commit!(null));
        return section('instancing', 'Instancing', 'layers', [
            h('div', { class: 'muted small pad', text: 'The meshes of this object and of the objects under it that share a shape and a material are drawn together, one draw call each: for many trees, rocks or fence posts. Moving them costs nothing extra; adding, removing or restyling them groups them again. Skinned meshes, transparent materials and mirrors draw on their own.' }),
            row('Drawn', drawn),
        ], [remove]);
    }

    private audioSection(): HTMLElement {
        const has: Filter = (n) => !!n.audio;
        const a = this.node.audio!;
        const sounds = this.store.doc.assets.filter((x) => x.kind === 'audio');
        const clip = new SelectField<string>([{ value: '', label: 'None' }, ...sounds.map((x) => ({ value: x.id, label: x.name }))], a.clip ?? '', (v) =>
            this.hooks<string | null>('Audio Clip', has, (n, x) => (n.audio!.clip = x)).commit!(v || null));
        this.watch(() => this.node.audio && clip.set(this.node.audio.clip ?? ''));
        const listen = iconButton('play', 'Listen (as recorded, not in 3D)', () => {
            const doc = this.node.audio;
            const meta = this.store.doc.assets.find((x) => x.id === doc?.clip);
            if (!doc || !meta) return toast('Choose a clip first.', 'info');
            toggleSound(meta, { volume: doc.volume, pitch: doc.pitch }).catch((e) => toast(e?.message || String(e), 'error'));
        });
        const library = iconButton('library', 'Find a sound in the Library', () => openLibraryDialog(this.editor, { kind: 'audio' }));
        const upload = iconButton('upload', 'Import a sound file', () => void this.editor.importSoundDialog());
        const remove = iconButton('trash', 'Remove audio', () => this.hooks<null>('Remove Audio', has, (n) => delete n.audio).commit!(null));
        return section('audio', 'Audio', 'speaker', [
            h('div', { class: 'muted small pad', text: 'Plays its clip in Play, heard from here (3D) or the same everywhere. Scripts control it with this.audio and play one-off sounds with this.playSound(name).' }),
            row('Clip', h('div', { class: 'inline grow' }, clip.el, listen, library, upload), 'A sound asset: import one, or add one from the Library'),
            ...this.componentRows('audio', ['volume', 'pitch', 'loop', 'autoplay', 'spatial', 'near', 'far']),
        ], [remove]);
    }

    // ---------------------------------------------------------------- model

    /** Selected model nodes of the same model file as the primary one. */
    private sameModel(): string[] {
        const asset = this.node.model?.asset;
        return this.store.selection.filter((id) => this.store.node(id)?.model?.asset === asset);
    }

    private modelHooks<T>(
        label: string,
        apply: (model: NonNullable<NodeDoc['model']>, v: T) => void,
        read?: (model: NonNullable<NodeDoc['model']>) => T | undefined,
    ): EditHooks<T> {
        const asset = this.node.model?.asset;
        return this.hooks<T>(label, (n) => n.model?.asset === asset, (n, v) => apply(n.model!, v), read && ((n) => read(n.model!)));
    }

    private modelSections(node: NodeDoc): HTMLElement[] {
        const asset = this.store.doc.assets.find((a) => a.id === node.model!.asset);
        const state = this.editor.sync.modelState(node.id);
        const info = this.editor.sync.modelInfo(node.id);
        const status = state?.status === 'ready' ? 'Loaded' : state?.status === 'error' ? `Failed: ${state.error}` : 'Loading...';
        // How games get it: its packed copy (KTX2 textures, meshopt geometry) or the file.
        const forGames = iconButton('sliders', 'Compression for games', (e) => {
            if (asset) openTextureOptions(this.editor, e.currentTarget as HTMLElement, asset.id, 'model');
        });
        forGames.disabled = !asset;
        const rows: HTMLElement[] = [
            row('File', h('div', { class: 'readonly', text: asset ? asset.name : 'Missing asset' })),
            row('Size', h('div', { class: 'inline' }, h('div', { class: 'readonly', text: asset ? formatBytes(asset.size) : '-' }), forGames)),
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
        if (info?.clips.length) out.push(this.animationSection(node, info.clips));
        if (info) {
            out.push(this.materialSlotsSection(node, info));
            out.push(this.partsSection(node, info));
        }
        return out;
    }

    /** The clip the model plays, and on a character the clip of each mode. */
    private animationSection(node: NodeDoc, clips: string[]): HTMLElement {
        const same: Filter = (n) => n.model?.asset === node.model!.asset;
        const clipRow = (key: 'clip' | (typeof ANIMATION_MODES)[number], empty: string) => {
            const label = key === 'clip' ? 'Clip' : key[0].toUpperCase() + key.slice(1);
            const edit = this.hooks<string>(`Animation ${label}`, same, (n, v) => (n.animation = Animation.parse({ ...n.animation, [key]: v })));
            const f = new SelectField<string>([{ value: '', label: empty }, ...clips.map((c) => ({ value: c, label: c }))], node.animation?.[key] ?? '', (v) => edit.commit!(v));
            this.watch(() => f.set(this.node.animation?.[key] ?? ''));
            return row(label, f.el);
        };
        let character = false;
        for (let n: NodeDoc | undefined = node; n && !character; n = this.store.node(n.parent)) character = !!n.character;
        return section('animation', 'Animation', 'play', [
            clipRow('clip', `First (${clips[0]})`),
            ...this.componentRows('animation', ['speed', 'fade', 'preview'], same),
            ...(character
                ? [
                      h('div', { class: 'muted small pad', text: "In Play the character's mode picks the clip:" }),
                      ...ANIMATION_MODES.map((m) => clipRow(m, `Auto (${clipFor(clips, defaults(Animation), m) ?? 'keeps the clip'})`)),
                  ]
                : []),
        ]);
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
        const head = pressable(h(
            'div',
            { class: 'part-row' + (open ? ' open' : '') + (focused ? ' focused' : '') + (visible ? '' : ' hidden-node'), attrs: { 'aria-expanded': String(open) } },
            icon('chevron', 12, 'slot-caret'),
            h('span', { class: 'part-name', text: part.name, title: part.path }),
            Object.keys(po).length ? h('span', { class: 'override-dot', title: 'Changed from the model file' }) : null,
            h('span', { class: 'part-meta', text: `${slotKey} · ${part.triangles.toLocaleString()} tris` }),
            eye,
        ));
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
            this.modelHooks<Vec3>(
                label,
                (model, v) => {
                    const parts = { ...(model.parts ?? {}) };
                    parts[part.path] = { ...(parts[part.path] ?? {}), [key]: v };
                    model.parts = parts;
                },
                (model) => model.parts?.[part.path]?.[key] ?? part.base[key],
            );
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

    // ---------------------------------------------------------------- agent

    /** Behavior edits of the section: through the edit operation layer, like every behavior edit. */
    private applyAgent(ops: unknown[], label: string) {
        if (!ops.length) return;
        const r = this.editor.applyBehaviorOps(ops, { label });
        if (!r.ok) {
            const e = r.errors[0];
            toast(e ? e.message : 'The change was refused.', 'error', 6000);
        }
    }

    private agentSection(node: NodeDoc): HTMLElement {
        const store = this.store;
        const doc = store.doc;
        const agent = node.agent!;
        const tree = doc.behaviors.find((t) => t.id === agent.tree);
        const schema = schemaOf(doc.blackboards, tree);
        const locked = this.editor.player.state !== 'stopped';
        /** Selected objects with an agent running the same tree (starting values only make sense there). */
        const peers = () => store.selection.map((id) => store.node(id)).filter((n): n is NodeDoc => !!n?.agent);
        const sameTree = () => peers().filter((n) => n.agent!.tree === this.node.agent?.tree);
        const rows: HTMLElement[] = [];
        if (locked) rows.push(h('div', { class: 'bt-banner' }, icon('lock', 13), h('span', { text: 'Playing: the Behavior tab shows the live blackboard. Stop to change the agent.' })));

        const treeOpts = doc.behaviors.map((t) => ({ value: t.id, label: t.name }));
        if (!tree) treeOpts.unshift({ value: agent.tree, label: `${agent.tree} (missing)` });
        const treePick = new SelectField(treeOpts, agent.tree, (id) => this.applyAgent(peers().map((n) => ({ op: 'set_agent', object: n.id, tree: id })), 'Agent Tree'));
        const show = iconButton('behavior', 'Show the tree in the Behavior tab', () => this.editor.showBehavior({ tree: this.node.agent?.tree }));
        rows.push(row('Tree', h('div', { class: 'inline grow' }, treePick.el, show), 'The behavior tree this object runs while playing, at 10 ticks a second.'));
        if (schema) rows.push(row('Blackboard', h('div', { class: 'readonly muted', text: `${schema.name} (${schema.keys.length} key${schema.keys.length === 1 ? '' : 's'})` })));

        const issues = h('div', { class: 'agent-issues' });
        rows.push(issues);
        const showIssues = () => {
            const n = this.node;
            clear(issues);
            if (!n.agent) return;
            for (const i of validateAgent(n.id, n.agent, store.doc)) {
                issues.appendChild(h('div', { class: 'bt-issue ' + i.severity }, icon('alert', 12), h('span', { text: i.message })));
            }
        };
        showIssues();

        if (schema?.keys.length) {
            rows.push(h('div', { class: 'agent-values-title muted small', text: 'Starting values (the schema default unless set here)' }));
            const ctx = { schema, objects: () => store.doc.nodes.filter((n) => !n.prefabChild).map((n) => ({ id: n.id, name: n.name })) };
            for (const key of schema.keys) {
                const label = `Agent Value ${key.name}`;
                const write = (v: unknown) =>
                    this.applyAgent(sameTree().map((n) => ({ op: 'set_agent', object: n.id, values: { ...n.agent!.values, [key.name]: v } })), label);
                const control = valueControl(key, Object.hasOwn(agent.values, key.name) ? agent.values[key.name] : key.default, ctx, this.steps.hooks(`Behavior: ${label}`, write));
                const reset = iconButton('undo', `Back to the schema default (${formatValue(key.default)})`, () =>
                    this.applyAgent(
                        sameTree()
                            .filter((n) => Object.hasOwn(n.agent!.values, key.name))
                            .map((n) => {
                                const values = { ...n.agent!.values };
                                delete values[key.name];
                                return { op: 'set_agent', object: n.id, values };
                            }),
                        `Reset ${key.name}`,
                    ),
                );
                const el = row(key.name, h('div', { class: 'inline grow' }, h('span', { class: 'bt-owner ' + key.owner, text: key.owner }), control.el, reset), `${keyTypeInfo(key.type).label}, ${key.owner === 'ai' ? 'written by one Ask' : key.owner === 'fact' ? 'written by scripts' : 'written by the tree'}. ${key.description}`);
                const sync = () => {
                    const a = this.node.agent;
                    if (!a) return;
                    const set = Object.hasOwn(a.values, key.name);
                    control.set(set ? a.values[key.name] : key.default);
                    reset.hidden = !set;
                    el.classList.toggle('overridden', set);
                };
                sync();
                this.watch(sync);
                rows.push(el);
            }
        } else if (schema) {
            rows.push(h('div', { class: 'muted small pad', text: 'The blackboard schema has no keys yet.' }));
        }

        const enabled = new CheckboxField(agent.enabled, (v) => this.applyAgent(peers().map((n) => ({ op: 'set_agent', object: n.id, enabled: v })), v ? 'Enable Agent' : 'Disable Agent'));
        enabled.el.title = 'Runs its tree while playing';
        this.watch(() => {
            const a = this.node.agent;
            if (!a) return;
            enabled.set(a.enabled);
            treePick.set(a.tree);
            showIssues();
        });
        const menu = iconButton('dots', 'Agent options', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                [
                    { label: 'Show in Behavior Tab', icon: 'behavior', action: () => this.editor.showBehavior({ tree: this.node.agent?.tree }) },
                    {
                        label: 'Reset Starting Values',
                        icon: 'undo',
                        enabled: () => !locked && sameTree().some((n) => Object.keys(n.agent!.values).length > 0),
                        action: () => this.applyAgent(sameTree().filter((n) => Object.keys(n.agent!.values).length).map((n) => ({ op: 'set_agent', object: n.id, values: {} })), 'Reset Agent Values'),
                    },
                    { separator: true },
                    { label: 'Remove Agent', icon: 'trash', enabled: () => !locked, action: () => this.applyAgent(peers().map((n) => ({ op: 'remove_agent', object: n.id })), 'Remove Agent') },
                ],
                r.left - 180,
                r.bottom + 4,
            );
        });
        const out = section('agent', 'Agent', 'agent', rows, [enabled.el, menu]);
        if (locked) {
            treePick.el.disabled = true;
            enabled.el.setAttribute('inert', '');
            out.querySelectorAll('.row').forEach((r) => r.setAttribute('inert', ''));
        }
        return out;
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
        if (!node.particles && !node.camera) {
            items.push({
                label: 'Particles',
                icon: 'sparkle',
                submenu: PARTICLE_PRESETS.map((pr) => ({
                    label: pr.label,
                    icon: 'sparkle',
                    action: () => this.hooks<null>('Add Particles', (n) => !n.particles, (n) => (n.particles = presetParticles(pr.id))).commit!(null),
                })),
            });
        }
        if (!node.camera && !node.mesh && !node.light && !node.model) {
            items.push({
                label: 'Camera',
                icon: 'camera',
                action: () => this.hooks<null>('Add Camera', (n) => !n.camera, (n) => (n.camera = defaultCameraDoc())).commit!(null),
            });
        }
        if (items.length) items.push({ separator: true });
        if (!node.player && !node.light && !node.camera && !node.particles && !node.body) {
            const specs = this.store.doc.design.specs;
            if (!node.character) items.push({ label: 'Character', icon: 'walk', action: () => this.hooks<null>('Add Character', (n) => !n.character, (n) => (n.character = defaultCharacter(specs))).commit!(null) });
            items.push({
                label: 'Player Controller',
                icon: 'play',
                action: () => this.hooks<null>('Add Player Controller', (n) => !n.player, (n) => {
                    n.character ??= defaultCharacter(specs);
                    n.player = defaultPlayer();
                }).commit!(null),
            });
        }
        if (!node.body && !node.character && !node.light && !node.camera && !node.particles) {
            items.push({ label: 'Physics Body', icon: 'physics', action: () => this.hooks<null>('Add Physics Body', (n) => !n.body && !n.character, (n) => (n.body = defaults(Body))).commit!(null) });
        }
        if (node.mesh && !node.mirror) {
            items.push({ label: 'Mirror', icon: 'mirror', action: () => this.hooks<null>('Add Mirror', (n) => !!n.mesh && !n.mirror, (n) => (n.mirror = defaults(Mirror))).commit!(null) });
        }
        if (!node.grass && !node.light && !node.camera) {
            // On a mesh or a model, the grass grows on it and covers it.
            items.push({ label: 'Grass', icon: 'grass', action: () => this.hooks<null>('Add Grass', (n) => !n.grass, (n) => (n.grass = this.editor.grassFor(n))).commit!(null) });
        }
        if (!node.rain && !node.light && !node.camera) {
            items.push({ label: 'Rain', icon: 'rain', action: () => this.hooks<null>('Add Rain', (n) => !n.rain, (n) => (n.rain = defaults(Rain))).commit!(null) });
        }
        if (!node.terrain && !node.mesh && !node.model && !node.light && !node.camera && !node.particles) {
            items.push({ label: 'Terrain (flat)', icon: 'terrain', action: () => this.hooks<null>('Add Terrain', (n) => !n.terrain && !n.mesh && !n.model, (n) => (n.terrain = defaults(Terrain))).commit!(null) });
        }
        if (!node.scatter && !node.mesh && !node.model && !node.light && !node.camera) {
            // On a terrain the copies stand on it, all over it.
            items.push({
                label: 'Scatter',
                icon: 'scatter',
                action: () => this.hooks<null>('Add Scatter', (n) => !n.scatter && !n.mesh && !n.model, (n) => {
                    const scatter = defaults(Scatter);
                    if (n.terrain) {
                        scatter.ground = n.id;
                        scatter.size = [n.terrain.size[0], n.terrain.size[1]];
                    }
                    n.scatter = scatter;
                }).commit!(null),
            });
        }
        if (!node.tree && !node.mesh && !node.model && !node.light && !node.camera && !node.terrain && !node.scatter) {
            items.push({
                label: 'Tree',
                icon: 'plant',
                submenu: TREE_SPECIES.map((sp) => ({
                    label: SPECIES_NAME[sp],
                    icon: 'plant',
                    action: () => this.hooks<null>('Add Tree', (n) => !n.tree && !n.mesh && !n.model, (n) => (n.tree = defaultTree(sp))).commit!(null),
                })),
            });
        }
        if (!node.audio && !node.light && !node.camera) {
            const first = this.store.doc.assets.find((a) => a.kind === 'audio')?.id ?? null;
            items.push({ label: 'Audio', icon: 'speaker', action: () => this.hooks<null>('Add Audio', (n) => !n.audio, (n) => (n.audio = { ...defaults(AudioSource), clip: first })).commit!(null) });
        }
        if (!node.instancing && !node.light && !node.camera) {
            items.push({ label: 'Instancing', icon: 'layers', action: () => this.hooks<null>('Add Instancing', (n) => !n.instancing, (n) => (n.instancing = defaults(Instancing))).commit!(null) });
        }
        if (!node.agent) {
            const stopped = () => this.editor.player.state === 'stopped';
            const trees = this.store.doc.behaviors;
            items.push({
                label: 'Agent (Behavior Tree)',
                icon: 'agent',
                enabled: stopped,
                submenu: [
                    ...trees.map((t) => ({
                        label: t.name,
                        icon: 'behavior',
                        action: () => this.applyAgent(this.store.selection.map((id) => ({ op: 'set_agent', object: id, tree: t.id, enabled: true })), 'Add Agent'),
                    })),
                    ...(trees.length ? [{ separator: true } as MenuItem] : []),
                    {
                        label: 'New Behavior Tree',
                        icon: 'plus',
                        action: () => {
                            const id = this.editor.newBehaviorTree({ assign: this.store.selection });
                            if (id) this.editor.showBehavior({ tree: id });
                        },
                    },
                ],
            });
        }
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
