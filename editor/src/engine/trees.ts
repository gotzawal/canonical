// Trees in the scene: a tree object (NodeDoc.tree) and the trees of a
// scatter. Each kind of tree is grown once (core/trees.ts) in a few
// variants, and they share one geometry: every variant at every level of
// detail, bark and leaves. Every copy is an instance (its place, turn,
// size and color in one buffer), so trees draw in a few calls however many
// there are. The copies are drawn in chunks of their area, each a renderer
// the engine leaves out when the view or a shadow map cannot see it;
// within a chunk every copy draws the level of detail its own distance
// calls for, its instances sorted by variant and level so each run of them
// is one draw.

import {
    BoundingBox, GeometryBase, MeshRenderer, Object3D, PassType, Reference, Vector3, VertexAttributeName, type ClusterLightingBuffer, type Material, type RendererPassState,
    type View3D,
} from '@orillusion/core';
import { quatRotate, type Quat, type Ray, type Vec3 } from '../core/math';
import type { ScatterSolid } from '../core/scatter';
import { growTree, variantSeed, type GrownTree, type TreeShape } from '../core/trees';
import { boxDistance, levelAt } from './chunks';
import { INSTANCE_FLOATS, TreeInstanceBuffer, TreeParams, treeMaterial } from './treeMaterials';
import { treeTextures, type TreeTextures } from './treeTextures';

/** One copy of a tree: where its foot is, its turn and size, which variant, and its color shift and seed (0 to 1). */
export interface TreeCopy {
    position: Vec3;
    rotation: Quat;
    scale: number;
    variant: number;
    hue: number;
    seed: number;
}

/** How a kind of tree looks beyond its shape: its colors and how the wind moves it. */
export interface TreeLook {
    /** Linear rgb times the painted leaves and bark (white keeps the species' own). */
    leafTint: [number, number, number];
    barkTint: [number, number, number];
    /** How far the leaves have turned, 0 to 1, and how much light they let through. */
    autumn: number;
    translucency: number;
    /** How much copies differ in color, 0 to 1. */
    vary: number;
    /** How much the wind moves it, times the species' own. */
    wind: number;
}

/** The color each species' leaves turn to in autumn (linear rgb); spruce keeps its needles green. */
const AUTUMN: Record<TreeShape['species'], [number, number, number] | null> = {
    oak: [0.42, 0.16, 0.035],
    birch: [0.62, 0.42, 0.04],
    spruce: null,
};

// ------------------------------------------------------------------ models

/** A kind of tree grown in its variants, with their shared geometry and textures. */
export class TreeModel {
    readonly geometry: GeometryBase;
    readonly textures: TreeTextures;
    readonly min: Vec3 = [Infinity, Infinity, Infinity];
    readonly max: Vec3 = [-Infinity, -Infinity, -Infinity];
    /** Triangles of a copy at each level of detail (the mean of the variants). */
    readonly triangles: number[];
    /** Kinds of copies drawing it in views (see acquire and release). */
    users = 0;
    /** Bytes of its vertices and indices. */
    readonly bytes: number;

    constructor(readonly shape: TreeShape, readonly variants: GrownTree[], readonly ctx: object, readonly key = '') {
        this.textures = treeTextures(shape.species, ctx);
        const parts = variants.flatMap((v) => [v.lods.map((l) => l.bark), v.lods.map((l) => l.leaves)]);
        let vertices = 0, indices = 0;
        for (const lods of parts) for (const m of lods) {
            vertices += m.positions.length / 3;
            indices += m.indices.length;
        }
        const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2), data = new Float32Array(vertices * 2);
        const index = new Uint32Array(indices);
        this.bytes = position.byteLength + normal.byteLength + uv.byteLength + data.byteLength + index.byteLength;
        const g = new GeometryBase();
        g.name = `Tree ${shape.species}`;
        let v0 = 0, i0 = 0;
        // Sub-shapes by variant and part (bark, leaves), each with its levels of detail as ranges of the index buffer.
        for (const lods of parts) {
            const levels = lods.map((m) => {
                const n = m.positions.length / 3;
                position.set(m.positions, v0 * 3);
                normal.set(m.normals, v0 * 3);
                uv.set(m.uvs, v0 * 2);
                data.set(m.data, v0 * 2);
                for (let k = 0; k < m.indices.length; k++) index[i0 + k] = m.indices[k] + v0;
                const level = { indexStart: i0, indexCount: m.indices.length, vertexStart: 0, vertexCount: 0, firstStart: 0, index: 0, topology: 0 };
                v0 += n;
                i0 += m.indices.length;
                return level;
            });
            g.addSubGeometry(...levels);
        }
        g.setAttribute(VertexAttributeName.position, position);
        g.setAttribute(VertexAttributeName.normal, normal);
        g.setAttribute(VertexAttributeName.uv, uv);
        g.setAttribute(VertexAttributeName.TEXCOORD_1, data);
        g.setIndices(index);
        for (const v of variants) {
            for (let k = 0; k < 3; k++) {
                this.min[k] = Math.min(this.min[k], v.min[k]);
                this.max[k] = Math.max(this.max[k], v.max[k]);
            }
        }
        g.bounds = new BoundingBox().setFromMinMax(new Vector3(...this.min), new Vector3(...this.max));
        // The cache keeps it: renderers that go do not free a shape others will draw.
        Reference.getInstance().attached(g, MODELS);
        this.geometry = g;
        this.triangles = [0, 1, 2].map((l) => variants.reduce((n, v) => n + (v.lods[l].bark.indices.length + v.lods[l].leaves.indices.length) / 3, 0) / variants.length);
    }

    get height(): number {
        return this.variants[0]?.height ?? 1;
    }

    /** Meters out from a copy's foot that its crown reaches, at scale 1, whichever way it is turned. */
    get reach(): number {
        return Math.max(Math.abs(this.min[0]), Math.abs(this.max[0]), Math.abs(this.min[2]), Math.abs(this.max[2]));
    }
}

/** Models by what they were grown from, per engine. */
const MODELS = new WeakMap<object, Map<string, TreeModel>>();
/**
 * Models no view draws, per engine, the longest unused first: kept a while
 * (an undo, a slider dragged back), the oldest freed past KEEP_IDLE.
 */
const IDLE = new WeakMap<object, TreeModel[]>();
const KEEP_IDLE = 4;

/** A kind of tree, grown once in `variants` variants (from `seed` on) and kept while views draw it. */
export function treeModel(shape: TreeShape, seed: number, variants: number, ctx: object): TreeModel {
    let mine = MODELS.get(ctx);
    if (!mine) MODELS.set(ctx, (mine = new Map()));
    const key = JSON.stringify([shape, seed, variants]);
    let m = mine.get(key);
    if (!m) {
        const grown = Array.from({ length: Math.max(1, variants) }, (_, k) => growTree(shape, variantSeed(seed, k)));
        m = new TreeModel(shape, grown, ctx, key);
        mine.set(key, m);
        // Unused until a view draws it (a kind may get no copies).
        idleOf(ctx).push(m);
    }
    return m;
}

/** The kinds of trees grown and kept for an engine, how many no view draws, and their vertex and index bytes. */
export function treeModelStats(ctx: object): { kinds: number; unused: number; bytes: number } {
    const all = [...(MODELS.get(ctx)?.values() ?? [])];
    return { kinds: all.length, unused: all.filter((m) => m.users === 0).length, bytes: all.reduce((n, m) => n + m.bytes, 0) };
}

function idleOf(ctx: object): TreeModel[] {
    let idle = IDLE.get(ctx);
    if (!idle) IDLE.set(ctx, (idle = []));
    return idle;
}

/** A view draws a model: it is no longer one to free. */
function acquire(m: TreeModel) {
    if (m.users++ > 0) return;
    const idle = idleOf(m.ctx);
    const i = idle.indexOf(m);
    if (i >= 0) idle.splice(i, 1);
}

/**
 * A view no longer draws a model: unused, it waits with the idle ones, and
 * the longest unused past KEEP_IDLE are freed (by `dispose`, once the GPU is
 * done with them).
 */
function release(m: TreeModel, dispose: (res: { destroy(force?: boolean): void }) => void) {
    if (--m.users > 0) return;
    const idle = idleOf(m.ctx);
    idle.push(m);
    while (idle.length > KEEP_IDLE) {
        const old = idle.shift()!;
        MODELS.get(old.ctx)?.delete(old.key);
        Reference.getInstance().detached(old.geometry, MODELS);
        dispose(old.geometry);
    }
}

// --------------------------------------------------------------- renderer

/** A run of copies of one variant at one level of detail, from `first` in the instance buffer. */
interface Run {
    variant: number;
    lod: number;
    first: number;
    count: number;
}

/**
 * A chunk's renderer: draws its runs of copies, each in one instanced draw
 * per part. Its materials bring their own passes (color and shadow): none
 * are made for it (depth prepass, GI, reflections, point shadows).
 */
class TreeRenderer extends MeshRenderer {
    runs: Run[] = [];

    protected castNeedPass() {}

    public renderPass2(view: View3D, passType: PassType, _state: RendererPassState, _cluster: ClusterLightingBuffer, encoder: GPURenderPassEncoder) {
        if (!this.enable || !this._geometry || !this.runs.length) return;
        if (passType !== PassType.COLOR && passType !== PassType.SHADOW) return;
        const gpu = view.engine3D.context3D.gpuContext;
        const subs = this._geometry.subGeometries;
        gpu.bindGeometryBuffer(encoder, this._geometry);
        for (let part = 0; part < this.materials.length; part++) {
            const material = this.materials[part];
            if (passType === PassType.SHADOW && !material.castShadow) continue;
            const passes = material.getPass(passType);
            if (!passes?.length) continue;
            for (const pass of passes) {
                if (!pass.pipeline) continue;
                gpu.bindPipeline(encoder, pass);
                for (const run of this.runs) {
                    const lod = subs[run.variant * 2 + part]?.lodLevels[run.lod];
                    if (lod?.indexCount) gpu.drawIndexed(encoder, lod.indexCount, run.count, lod.indexStart, 0, run.first);
                }
            }
        }
    }
}

// -------------------------------------------------------------------- view

/** A part of the area: its copies, its renderer, and the box they fill. */
interface Chunk {
    obj: Object3D;
    renderer: TreeRenderer;
    /** Its copies (indices into the group's), and the level each draws (-1: none). */
    ids: number[];
    levels: Int8Array;
    /** Where its copies start in the instance buffer. */
    first: number;
    min: Vec3;
    max: Vec3;
    data: Float32Array;
}

/** The copies of one kind of tree in a view, with their materials and buffers. */
interface Group {
    /** What the kind was built with (a scatter's source), to change its look by. */
    id: number;
    model: TreeModel;
    params: TreeParams;
    instances: TreeInstanceBuffer;
    materials: Material[];
    copies: TreeCopy[];
    chunks: Chunk[];
    look: TreeLook;
}

/** Copies per chunk to aim at, and the most chunks a side. */
const PER_CHUNK = 96;
const MAX_CHUNKS = 8;
/** Heights from the camera (at least these meters) where copies switch to levels 1 and 2. */
const LOD_NEAR = { meters: 12, heights: 2.4 };
const LOD_FAR = { meters: 30, heights: 7.5 };
/** Meters (times the level of detail scale) within which shadows follow the wind every frame. */
const WIND_SHADOW_DISTANCE = 70;
/** Meters the camera moves before the copies' levels are looked at again. */
const MOVE = 0.4;

export class TreeView {
    readonly root = new Object3D();
    private groups: Group[] = [];
    private visible = true;
    private castShadow = true;
    /** Meters beyond which copies are not drawn; 0 for any distance. */
    private drawDistance = 0;
    private lodScale = 1;
    private wind = { direction: 0, speed: 0 };
    private eye: Vec3 = [Infinity, 0, 0];
    /** Copies placed. */
    count = 0;

    constructor(scene: Object3D, private ctx: object, name = 'Trees') {
        this.root.name = name;
        scene.addChild(this.root);
    }

    /**
     * Makes the copies anew: `copies[i]` of `models[i]`, each kind with its
     * look. `dispose` frees what the old copies held once the GPU is done.
     */
    build(kinds: { model: TreeModel; look: TreeLook; copies: TreeCopy[]; id?: number }[], castShadow: boolean, dispose: (res: { destroy(force?: boolean): void }) => void) {
        // The new kinds' models first: freeing the old ones must not free one drawn again.
        for (const kind of kinds) if (kind.copies.length) acquire(kind.model);
        this.clear(dispose);
        this.castShadow = castShadow;
        this.count = 0;
        for (const kind of kinds) {
            if (!kind.copies.length) continue;
            this.groups.push(this.makeGroup(kind.model, kind.look, kind.copies, kind.id ?? this.groups.length));
            this.count += kind.copies.length;
        }
        this.applyWind();
        this.setVisible(this.visible);
        this.eye = [Infinity, 0, 0];
    }

    private makeGroup(model: TreeModel, look: TreeLook, copies: TreeCopy[], id: number): Group {
        const params = new TreeParams(this.ctx);
        const instances = new TreeInstanceBuffer(copies.length, this.ctx);
        const materials = [treeMaterial('bark', model.textures, params, instances, this.ctx), treeMaterial('leaves', model.textures, params, instances, this.ctx)];
        const group: Group = { id, model, params, instances, materials, copies, chunks: [], look };
        this.applyLook(group);
        // Chunks over the copies' extent, about PER_CHUNK copies each.
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const c of copies) {
            x0 = Math.min(x0, c.position[0]);
            x1 = Math.max(x1, c.position[0]);
            z0 = Math.min(z0, c.position[2]);
            z1 = Math.max(z1, c.position[2]);
        }
        const side = Math.max(1, Math.min(MAX_CHUNKS, Math.round(Math.sqrt(copies.length / PER_CHUNK))));
        const w = Math.max(1e-6, x1 - x0) / side, d = Math.max(1e-6, z1 - z0) / side;
        const cells: number[][] = Array.from({ length: side * side }, () => []);
        copies.forEach((c, k) => {
            const i = Math.min(side - 1, Math.floor((c.position[0] - x0) / w));
            const j = Math.min(side - 1, Math.floor((c.position[2] - z0) / d));
            cells[j * side + i].push(k);
        });
        let first = 0;
        for (const ids of cells) {
            if (!ids.length) continue;
            group.chunks.push(this.makeChunk(group, ids, first));
            first += ids.length;
        }
        return group;
    }

    private makeChunk(group: Group, ids: number[], first: number): Chunk {
        const obj = new Object3D();
        obj.name = 'Tree chunk';
        this.root.addChild(obj);
        const renderer = obj.addComponent(TreeRenderer);
        renderer.geometry = group.model.geometry;
        renderer.materials = group.materials;
        renderer.castShadow = this.castShadow;
        renderer.receiveShadow = true;
        renderer.castGI = false;
        renderer.castReflection = false;
        renderer.frustumCulled = true;
        const chunk: Chunk = { obj, renderer, ids, levels: new Int8Array(ids.length).fill(-2), first, min: [0, 0, 0], max: [0, 0, 0], data: new Float32Array(ids.length * INSTANCE_FLOATS) };
        this.fit(group, chunk);
        return chunk;
    }

    /** A chunk's box: every copy's, wide enough for it turned any way and swaying. */
    private fit(group: Group, chunk: Chunk) {
        const m = group.model;
        const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const id of chunk.ids) {
            const c = group.copies[id];
            const reach = m.reach * c.scale + 0.5 + 0.06 * m.height * c.scale;
            min[0] = Math.min(min[0], c.position[0] - reach);
            max[0] = Math.max(max[0], c.position[0] + reach);
            min[2] = Math.min(min[2], c.position[2] - reach);
            max[2] = Math.max(max[2], c.position[2] + reach);
            min[1] = Math.min(min[1], c.position[1] + m.min[1] * c.scale - 0.5);
            max[1] = Math.max(max[1], c.position[1] + m.max[1] * c.scale + 0.5);
        }
        chunk.min = min;
        chunk.max = max;
        chunk.renderer.cullBounds = new BoundingBox().setFromMinMax(new Vector3(...min), new Vector3(...max));
    }

    /**
     * Moves the copies of the kind built `kind`th: as many as it has (a tree
     * object dragged), without making anything again. False when the count
     * differs (build again).
     */
    move(kind: number, copies: TreeCopy[]): boolean {
        const g = this.groups[kind];
        if (!g || g.copies.length !== copies.length) return false;
        g.copies = copies;
        for (const c of g.chunks) {
            this.fit(g, c);
            c.levels.fill(-2);
        }
        this.eye = [Infinity, 0, 0];
        return true;
    }

    /** Sets a kind's colors and wind on its uniforms. */
    private applyLook(g: Group) {
        const l = g.look;
        const t = g.model.textures;
        const fall = AUTUMN[g.model.shape.species];
        const bright = 0.2126 * t.leafColor[0] + 0.7152 * t.leafColor[1] + 0.0722 * t.leafColor[2];
        g.params.set({
            leafTint: [...l.leafTint, l.translucency],
            barkTint: [...l.barkTint, l.vary],
            motion: [0.035 * l.wind, l.wind, 0.012 * g.model.height * l.wind, g.model.height],
            cut: [0.5, 0.32, 0, bright],
            autumn: fall ? [...fall, l.autumn] : [0, 0, 0, 0],
        });
    }

    /** Changes the colors and wind of every kind (the trees stay). */
    setLook(look: TreeLook) {
        for (const g of this.groups) {
            g.look = look;
            this.applyLook(g);
        }
    }

    /** Changes each kind's colors and wind, by what it was built with (`looks[id]`); the trees stay. */
    setLooks(looks: readonly (TreeLook | null)[]) {
        for (const g of this.groups) {
            const look = looks[g.id];
            if (!look || JSON.stringify(look) === JSON.stringify(g.look)) continue;
            g.look = look;
            this.applyLook(g);
        }
    }

    /** The wind the trees sway in: where it blows toward (degrees around +Y from +X) and its speed, m/s. */
    setWind(direction: number, speed: number) {
        if (direction === this.wind.direction && speed === this.wind.speed) return;
        this.wind = { direction, speed };
        this.applyWind();
    }

    private applyWind() {
        const a = (this.wind.direction * Math.PI) / 180;
        const strength = Math.min(2.5, Math.max(0, this.wind.speed / 6));
        for (const g of this.groups) g.params.set({ wind: [Math.cos(a), Math.sin(a), strength, Math.max(1, this.wind.speed)] });
    }

    setVisible(visible: boolean) {
        this.visible = visible;
        for (const g of this.groups) for (const c of g.chunks) c.renderer.enable = visible && c.renderer.runs.length > 0;
    }

    setDrawDistance(meters: number) {
        if (meters === this.drawDistance) return;
        this.drawDistance = meters;
        this.eye = [Infinity, 0, 0];
    }

    /** Scales the distances where copies switch to simpler levels (the graphics tier's). */
    setLodScale(scale: number) {
        const s = Math.max(0.1, scale);
        if (s === this.lodScale) return;
        this.lodScale = s;
        this.eye = [Infinity, 0, 0];
    }

    setCastShadow(cast: boolean) {
        this.castShadow = cast;
        for (const g of this.groups) for (const c of g.chunks) c.renderer.castShadow = cast;
    }

    /**
     * Fits the copies to a camera at `eye` (world): each draws the level its
     * distance calls for (with a margin, so one at a limit does not flicker),
     * none past the draw distance. A chunk whose levels changed writes its
     * copies again, sorted into runs.
     */
    update(eye: ArrayLike<number>) {
        if (!this.visible || !this.groups.length) return;
        const e = this.eye;
        if (Math.hypot(eye[0] - e[0], eye[1] - e[1], eye[2] - e[2]) < MOVE) return;
        e[0] = eye[0];
        e[1] = eye[1];
        e[2] = eye[2];
        const windy = this.wind.speed > 0.3;
        for (const g of this.groups) {
            const h = g.model.height;
            for (const c of g.chunks) {
                const near = boxDistance(c.min, c.max, e);
                // Shadows near the camera follow the wind every frame; farther ones are kept until they change.
                c.renderer.shadowCacheMode = windy && near < WIND_SHADOW_DISTANCE * this.lodScale ? 'dynamic' : 'auto';
                let changed = false;
                for (let k = 0; k < c.ids.length; k++) {
                    const copy = g.copies[c.ids[k]];
                    const height = h * copy.scale;
                    const d = Math.hypot(copy.position[0] - e[0], copy.position[1] + height * 0.45 - e[1], copy.position[2] - e[2]);
                    const cur = c.levels[k];
                    let level: number;
                    if (this.drawDistance > 0 && d > this.drawDistance * (cur === -1 ? 0.97 : 1.03)) level = -1;
                    else {
                        const lodNear = Math.max(LOD_NEAR.meters, LOD_NEAR.heights * height) * this.lodScale;
                        const lodFar = Math.max(LOD_FAR.meters, LOD_FAR.heights * height) * this.lodScale;
                        level = levelAt(d, lodNear, lodFar, cur < 0 ? 0 : cur);
                    }
                    if (level !== cur) {
                        c.levels[k] = level;
                        changed = true;
                    }
                }
                if (changed) this.write(g, c);
            }
        }
    }

    /** Writes a chunk's copies sorted into runs (by variant and level) and gives its renderer the runs. */
    private write(g: Group, c: Chunk) {
        const variants = g.model.variants.length;
        const counts = new Int32Array(variants * 3);
        for (let k = 0; k < c.ids.length; k++) if (c.levels[k] >= 0) counts[g.copies[c.ids[k]].variant * 3 + c.levels[k]]++;
        const starts = new Int32Array(variants * 3);
        const runs: Run[] = [];
        let at = 0;
        for (let b = 0; b < counts.length; b++) {
            starts[b] = at;
            if (counts[b]) runs.push({ variant: Math.floor(b / 3), lod: b % 3, first: c.first + at, count: counts[b] });
            at += counts[b];
        }
        const out = c.data;
        for (let k = 0; k < c.ids.length; k++) {
            if (c.levels[k] < 0) continue;
            const copy = g.copies[c.ids[k]];
            const o = starts[copy.variant * 3 + c.levels[k]]++ * INSTANCE_FLOATS;
            out[o] = copy.position[0];
            out[o + 1] = copy.position[1];
            out[o + 2] = copy.position[2];
            out[o + 3] = copy.scale;
            out[o + 4] = copy.rotation[0];
            out[o + 5] = copy.rotation[1];
            out[o + 6] = copy.rotation[2];
            out[o + 7] = copy.rotation[3];
            out[o + 8] = copy.hue;
            out[o + 9] = copy.seed;
            out[o + 10] = 0;
            out[o + 11] = 0;
        }
        if (at) g.instances.write(c.first, out.subarray(0, at * INSTANCE_FLOATS));
        c.renderer.runs = runs;
        // A shadow map kept since it was drawn knows a renderer by its level: a new one draws it again.
        c.renderer.lodLevel = (c.renderer.lodLevel + 1) % 1024;
        const on = this.visible && runs.length > 0;
        if (c.renderer.enable !== on) c.renderer.enable = on;
    }

    /** What it draws, for the profiler: copies by level, chunks shown, and triangles. */
    report(): string {
        const levels = [0, 0, 0];
        let shown = 0, chunks = 0, tris = 0;
        for (const g of this.groups) {
            for (const c of g.chunks) {
                chunks++;
                if (c.renderer.enable) shown++;
                for (let k = 0; k < c.levels.length; k++) {
                    if (c.levels[k] < 0) continue;
                    levels[c.levels[k]]++;
                    tris += g.model.triangles[c.levels[k]];
                }
            }
        }
        return `${this.count.toLocaleString('en-US')} tree${this.count === 1 ? '' : 's'} (levels ${levels.join(' / ')}), ${shown}/${chunks} chunks, ${Math.round(tris / 1000).toLocaleString('en-US')}k triangles`;
    }

    /** Triangles of a copy of its first kind at each level of detail (near to far), or null without copies. */
    levelTriangles(): number[] | null {
        return this.groups[0]?.model.triangles.map(Math.round) ?? null;
    }

    /** The trunks of its copies as solids: upright cylinders as high as the bare trunk and a little more. */
    trunks(): ScatterSolid[] {
        const out: ScatterSolid[] = [];
        for (const g of this.groups) {
            for (const c of g.copies) {
                const v = g.model.variants[c.variant] ?? g.model.variants[0];
                out.push({ kind: 'trunk', center: [c.position[0], c.position[1], c.position[2]], size: [v.trunk.radius * c.scale, Math.max(2, v.trunk.height * 1.2) * c.scale, v.trunk.radius * c.scale], yaw: 0 });
            }
        }
        return out;
    }

    /** A renderer of its copies (what a pick says was hit), or null without copies. */
    get renderer(): MeshRenderer | null {
        return this.groups[0]?.chunks[0]?.renderer ?? null;
    }

    /** The world box of every copy, or null without copies. */
    bounds(): { min: Vec3; max: Vec3 } | null {
        let min: Vec3 | null = null, max: Vec3 | null = null;
        for (const g of this.groups) {
            for (const c of g.chunks) {
                min = min ? [Math.min(min[0], c.min[0]), Math.min(min[1], c.min[1]), Math.min(min[2], c.min[2])] : [...c.min];
                max = max ? [Math.max(max[0], c.max[0]), Math.max(max[1], c.max[1]), Math.max(max[2], c.max[2])] : [...c.max];
            }
        }
        return min && max ? { min, max } : null;
    }

    /**
     * The nearest copy a ray meets within `maxDist`: its trunk (an upright
     * cylinder) or its crown (an ellipsoid), at the copy's place and size.
     */
    hit(ray: Ray, maxDist: number): number | null {
        if (!this.visible) return null;
        let best: number | null = null;
        for (const g of this.groups) {
            const tree = g.model.variants;
            for (const copy of g.copies) {
                const v = tree[copy.variant] ?? tree[0];
                const s = copy.scale;
                // Into the copy's space: turned back and scaled down.
                const inv: Quat = [-copy.rotation[0], -copy.rotation[1], -copy.rotation[2], copy.rotation[3]];
                const o = quatRotate(inv, [(ray.origin[0] - copy.position[0]) / s, (ray.origin[1] - copy.position[1]) / s, (ray.origin[2] - copy.position[2]) / s]);
                const d = quatRotate(inv, ray.dir);
                const limit = Math.min(maxDist, best ?? Infinity) / s;
                const t = Math.min(rayCylinder(o, d, v.trunk.radius, v.max[1] * 0.6) ?? Infinity, rayEllipsoid(o, d, v.crown.center, v.crown.radius) ?? Infinity);
                if (t <= limit) best = t * s;
            }
        }
        return best;
    }

    private clear(dispose: (res: { destroy(force?: boolean): void }) => void) {
        for (const g of this.groups) {
            for (const c of g.chunks) {
                c.obj.removeFromParent();
                dispose(c.obj);
            }
            dispose(g.params);
            dispose(g.instances);
            release(g.model, dispose);
        }
        this.groups = [];
        this.count = 0;
    }

    dispose(dispose: (res: { destroy(force?: boolean): void }) => void) {
        this.clear(dispose);
        this.root.removeFromParent();
        this.root.destroy();
    }
}

/** Distance along a ray (in a copy's space) to an upright cylinder from y 0 to `height`, or null. */
function rayCylinder(o: Vec3, d: Vec3, r: number, height: number): number | null {
    const a = d[0] * d[0] + d[2] * d[2];
    if (a < 1e-12) return null;
    const b = 2 * (o[0] * d[0] + o[2] * d[2]);
    const c = o[0] * o[0] + o[2] * o[2] - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) return null;
    const y = o[1] + d[1] * t;
    return y >= 0 && y <= height ? t : null;
}

/** Distance along a ray to an ellipsoid (its middle and radii), or null. */
function rayEllipsoid(o: Vec3, d: Vec3, center: Vec3, radius: Vec3): number | null {
    // In the space where the ellipsoid is the unit sphere.
    const p = [0, 1, 2].map((k) => (o[k] - center[k]) / radius[k]);
    const q = [0, 1, 2].map((k) => d[k] / radius[k]);
    const a = q[0] * q[0] + q[1] * q[1] + q[2] * q[2];
    const b = 2 * (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]);
    const c = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0 || a < 1e-12) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 ? t : null;
}
