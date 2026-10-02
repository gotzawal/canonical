// A scatter's copies in the scene (NodeDoc.scatter, core/scatter.ts). Each
// source model is taken apart once (its parts, box and trunk); a copy is a
// renderer per part. The copies are drawn instanced, one instancer per cell
// of the area, with the cell's box to cull by: the engine leaves out the
// cells a camera cannot see, the view's and each shadow map's on their own.
// Each part also has simpler versions (levels of detail: the same vertices,
// fewer triangles, made with meshoptimizer's simplifier), and each cell
// draws the level its distance from the camera calls for.
// The root sits at the scene's root and the copies are placed in world space.

import {
    BoundingBox, InstanceDrawComponent, Material, MeshRenderer, Object3D, Quaternion, RenderNode, SkinnedMeshRenderer, SkinnedMeshRenderer2, Vector3,
    VertexAttributeName, type Context3D, type GeometryBase, type Texture,
} from '@orillusion/core';
import { compose, decompose, invert, mul, rayBox, type Mat4, type Ray } from '../core/math';
import type { Placement } from '../core/scatter';
import type { Vec3 } from '../core/types';
import { boxDistance, levelAt } from './chunks';
import { geometryWithLods } from './lod';
import { partPaths } from './modelParts';
import { RockGround } from './rockGround';

/** A part of a source model: its shape and materials, and its matrix in the model's space. */
interface Part {
    geometry: GeometryBase;
    materials: Material[];
    matrix: Mat4;
}

/** What a copy shows: parts, their box, and what reaches the ground (a trunk, a rock's foot). */
export interface ScatterPiece {
    parts: Part[];
    /** The model's renderers it is made of, and how far it was moved to stand at its origin. */
    renderers: RenderNode[];
    offset: Vec3;
    min: Vec3;
    max: Vec3;
    /** The middle and radius of what reaches the ground, in the piece's space. */
    trunk: { x: number; z: number; radius: number };
    /** Eight points around its bottom, in its space (where it meets the ground). */
    base: Vec3[];
}

/**
 * A source model taken apart for its copies. A model that is a set of
 * pieces side by side (rocks, grass clumps) gives each piece standing at
 * its own origin, and each copy shows one; any other model is one piece.
 */
export class ScatterModel {
    readonly pieces: ScatterPiece[] = [];
    /** The path of each renderer of the model, as a model object names its parts (ModelDoc.parts). */
    readonly paths: Map<RenderNode, string>;
    /** The model's root matrix, which copies leave out and a model object keeps. */
    readonly root: Mat4;

    constructor(prefab: Object3D) {
        this.paths = partPaths(prefab);
        prefab.transform.updateWorldMatrix(true);
        this.root = new Float64Array(prefab.transform.worldMatrix.rawData);
        const toModel = invert(this.root) ?? new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        // The pieces of a set are the children where the model first branches.
        let top = prefab;
        while (top.entityChildren.length === 1 && !rendererOf(top)) top = top.entityChildren[0] as Object3D;
        const groups = !rendererOf(top) && top.entityChildren.length > 1 ? (top.entityChildren as Object3D[]).map((c) => pieceOf(c, toModel)).filter((p) => p.parts.length) : [];
        if (groups.length > 1 && apart(groups)) {
            for (const g of groups) this.pieces.push(standing(g));
        } else {
            const whole = pieceOf(prefab, toModel);
            if (whole.parts.length) this.pieces.push(whole);
        }
    }

    /** The piece a copy shows, by its variant (0 to 1). */
    piece(variant: number): ScatterPiece | null {
        return this.pieces[Math.min(this.pieces.length - 1, Math.floor(variant * this.pieces.length))] ?? null;
    }

    /**
     * Gives every part its simpler levels of detail (1 and 2), when the
     * simplifier loads; parts keep their own shape otherwise. A shape the
     * pieces share is simplified once.
     */
    async addLods(): Promise<void> {
        for (const piece of this.pieces) {
            for (const part of piece.parts) part.geometry = await geometryWithLods(part.geometry);
        }
    }
}

function rendererOf(o: Object3D): boolean {
    return o.components ? Array.from(o.components.values()).some((c) => c instanceof MeshRenderer) : false;
}

/** The static mesh parts under `root`, in the model's space, with their box and trunk. */
function pieceOf(root: Object3D, toModel: ArrayLike<number>): ScatterPiece {
    const piece: ScatterPiece = { parts: [], renderers: [], offset: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], trunk: { x: 0, z: 0, radius: 0.1 }, base: [] };
    const points: number[] = [];
    root.traverse((o: Object3D) => {
        o.components.forEach((c) => {
            if (!(c instanceof MeshRenderer) || c instanceof SkinnedMeshRenderer || c instanceof SkinnedMeshRenderer2) return;
            if (!c.geometry || !c.materials?.length || c.morphData?.enable) return;
            o.transform.updateWorldMatrix(true);
            const matrix = mul(toModel, o.transform.worldMatrix.rawData);
            piece.parts.push({ geometry: c.geometry, materials: c.materials.slice(), matrix });
            piece.renderers.push(c);
            const pos = c.geometry.getAttribute(VertexAttributeName.position)?.data as ArrayLike<number> | undefined;
            if (!pos) return;
            for (let i = 0; i + 2 < pos.length; i += 3) {
                const x = pos[i], y = pos[i + 1], z = pos[i + 2];
                const p = [
                    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
                    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
                    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
                ];
                points.push(p[0], p[1], p[2]);
                for (let k = 0; k < 3; k++) {
                    if (p[k] < piece.min[k]) piece.min[k] = p[k];
                    if (p[k] > piece.max[k]) piece.max[k] = p[k];
                }
            }
        });
    });
    fitTrunk(piece, points);
    return piece;
}

/**
 * The trunk: the points in the lowest seventh of the piece, their middle
 * and how far most of them reach from it (roots and flares aside).
 */
function fitTrunk(piece: ScatterPiece, points: number[]) {
    if (!points.length) return;
    const low = piece.min[1] + (piece.max[1] - piece.min[1]) / 7;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
        if (points[i + 1] > low) continue;
        x0 = Math.min(x0, points[i]);
        x1 = Math.max(x1, points[i]);
        z0 = Math.min(z0, points[i + 2]);
        z1 = Math.max(z1, points[i + 2]);
    }
    if (!(x1 >= x0)) return;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const reach: number[] = [];
    for (let i = 0; i < points.length; i += 3) if (points[i + 1] <= low) reach.push(Math.hypot(points[i] - cx, points[i + 2] - cz));
    reach.sort((a, b) => a - b);
    const footprint = Math.max(piece.max[0] - piece.min[0], piece.max[2] - piece.min[2]);
    piece.trunk = { x: cx, z: cz, radius: Math.max(0.03, Math.min(reach[Math.floor(reach.length * 0.8)] ?? 0.1, footprint / 2)) };
    // The base: the low points farthest out in eight directions.
    const best = new Array<number>(8).fill(-Infinity);
    for (let i = 0; i < points.length; i += 3) {
        if (points[i + 1] > low) continue;
        for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4;
            const out = (points[i] - cx) * Math.cos(a) + (points[i + 2] - cz) * Math.sin(a);
            if (out > best[k]) {
                best[k] = out;
                piece.base[k] = [points[i], points[i + 1], points[i + 2]];
            }
        }
    }
}

/** Whether pieces stand apart on the ground (a set), rather than together (a trunk and its leaves). */
function apart(pieces: ScatterPiece[]): boolean {
    let area = 0, overlap = 0;
    for (let i = 0; i < pieces.length; i++) {
        const a = pieces[i];
        area += Math.max(0, a.max[0] - a.min[0]) * Math.max(0, a.max[2] - a.min[2]);
        for (let j = i + 1; j < pieces.length; j++) {
            const b = pieces[j];
            const w = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
            const d = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
            if (w > 0 && d > 0) overlap += w * d;
        }
    }
    return area > 0 && overlap < area * 0.1;
}

/** A piece of a set moved to stand at its own origin: its middle over it, its bottom on it. */
function standing(p: ScatterPiece): ScatterPiece {
    const dx = -(p.min[0] + p.max[0]) / 2, dy = -p.min[1], dz = -(p.min[2] + p.max[2]) / 2;
    const parts = p.parts.map((part) => {
        const matrix = new Float64Array(part.matrix);
        matrix[12] += dx;
        matrix[13] += dy;
        matrix[14] += dz;
        return { ...part, matrix };
    });
    return {
        parts,
        renderers: p.renderers,
        offset: [dx, dy, dz],
        min: [p.min[0] + dx, p.min[1] + dy, p.min[2] + dz],
        max: [p.max[0] + dx, p.max[1] + dy, p.max[2] + dz],
        trunk: { x: p.trunk.x + dx, z: p.trunk.z + dz, radius: p.trunk.radius },
        base: p.base.map((b) => [b[0] + dx, b[1] + dy, b[2] + dz] as Vec3),
    };
}

/** Copies in one cell of the area: their instancer, renderers, and the box they fill. */
interface Cell {
    obj: Object3D;
    instancer: InstanceDrawComponent;
    renderers: MeshRenderer[];
    /** World boxes of the renderers, six numbers each (min x, y, z, max x, y, z). */
    boxes: Float64Array;
    min: Vec3;
    max: Vec3;
    /** The level of detail drawn, and the copies' mean radius (meters), which sets where the levels change. */
    level: number;
    radius: number;
}

/** Copies per cell to aim at, and the most cells a side. */
const PER_CELL = 32;
const MAX_CELLS = 6;

/** Meters (at least) and copy radii from the camera where cells switch to levels 1 and 2. */
const LOD_NEAR = { meters: 12, radii: 25 };
const LOD_FAR = { meters: 30, radii: 70 };

const pos = new Vector3();
const scl = new Vector3();
const rot = new Quaternion();

export class ScatterView {
    readonly root = new Object3D();
    private cells: Cell[] = [];
    private visible = true;
    /** Meters from the camera beyond which cells are not drawn; 0 for any distance. */
    private drawDistance = 0;
    /** Scales the distances where cells switch to simpler levels (the graphics tier's: nearer on weak devices). */
    private lodScale = 1;
    /** Copies made. */
    count = 0;
    /** What its copies read to sit in the ground (soil, moss, variation). */
    readonly ground: RockGround;

    constructor(scene: Object3D, private ctx: Context3D, readonly id: string, heights: Texture) {
        this.root.name = 'Scatter';
        scene.addChild(this.root);
        this.ground = new RockGround(heights);
    }

    /**
     * Makes the copies anew: `models[p.source]` gives each its parts (a
     * source whose model is not loaded places nothing). `dispose` frees
     * what the old copies held once the GPU is done with it.
     */
    build(placements: readonly Placement[], models: readonly (ScatterModel | null)[], castShadow: boolean, dispose: (res: { destroy(force?: boolean): void }) => void) {
        this.clear(dispose);
        const list = placements.filter((p) => models[p.source]?.piece(p.variant));
        this.count = list.length;
        if (!list.length) return;
        // Cells over the copies' extent, about PER_CELL copies each.
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const p of list) {
            x0 = Math.min(x0, p.position[0]);
            x1 = Math.max(x1, p.position[0]);
            z0 = Math.min(z0, p.position[2]);
            z1 = Math.max(z1, p.position[2]);
        }
        const side = Math.max(1, Math.min(MAX_CELLS, Math.round(Math.sqrt(list.length / PER_CELL))));
        const w = Math.max(1e-6, x1 - x0) / side, d = Math.max(1e-6, z1 - z0) / side;
        const groups: Placement[][] = Array.from({ length: side * side }, () => []);
        for (const p of list) {
            const i = Math.min(side - 1, Math.floor((p.position[0] - x0) / w));
            const j = Math.min(side - 1, Math.floor((p.position[2] - z0) / d));
            groups[j * side + i].push(p);
        }
        for (const group of groups) if (group.length) this.cells.push(this.makeCell(group, models, castShadow));
        this.setVisible(this.visible);
    }

    private makeCell(group: Placement[], models: readonly (ScatterModel | null)[], castShadow: boolean): Cell {
        const obj = new Object3D();
        obj.name = 'Scatter cell';
        this.root.addChild(obj);
        // The instancer compiles the materials it draws for itself: each cell draws copies of its own.
        const copies = new Map<Material, Material>();
        const materialOf = (m: Material) => {
            let c = copies.get(m);
            if (!c) copies.set(m, (c = this.ground.material(m, this.ctx)));
            return c;
        };
        const renderers: MeshRenderer[] = [];
        const boxes: number[] = [];
        const min: Vec3 = [Infinity, Infinity, Infinity];
        const max: Vec3 = [-Infinity, -Infinity, -Infinity];
        let radii = 0;
        for (const p of group) {
            const piece = models[p.source]!.piece(p.variant)!;
            radii += (Math.hypot(piece.max[0] - piece.min[0], piece.max[1] - piece.min[1], piece.max[2] - piece.min[2]) / 2) * p.scale;
            const copy = compose(p.position, p.rotation, [p.scale, p.scale, p.scale]);
            for (const part of piece.parts) {
                const m = mul(copy, part.matrix);
                const t = decompose(m);
                const o = new Object3D();
                obj.addChild(o);
                pos.set(t.position[0], t.position[1], t.position[2]);
                rot.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
                scl.set(t.scale[0], t.scale[1], t.scale[2]);
                o.transform.localPosition = pos;
                o.transform.localRotQuat = rot;
                o.transform.localScale = scl;
                const r = o.addComponent(MeshRenderer);
                r.geometry = part.geometry;
                r.materials = part.materials.map(materialOf);
                r.castShadow = castShadow;
                r.receiveShadow = true;
                r.castGI = true;
                renderers.push(r);
                boxOf(part.geometry, m, min, max, boxes);
            }
        }
        const instancer = obj.addComponent(InstanceDrawComponent);
        instancer.autoGroup = false;
        instancer.castGI = true;
        // Its copies never move: a shadow map draws them again only when the scatter is placed anew.
        instancer.shadowCacheMode = 'static';
        instancer.cullBounds = new BoundingBox().setFromMinMax(new Vector3(min[0], min[1], min[2]), new Vector3(max[0], max[1], max[2]));
        instancer.frustumCulled = true;
        instancer.rebuild(renderers);
        return { obj, instancer, renderers, boxes: new Float64Array(boxes), min, max, level: 0, radius: radii / Math.max(1, group.length) };
    }

    setVisible(visible: boolean) {
        this.visible = visible;
        for (const c of this.cells) c.instancer.enable = visible;
    }

    setDrawDistance(meters: number) {
        if (meters === this.drawDistance) return;
        this.drawDistance = meters;
        // Every cell shows again; the next frame leaves out those too far.
        this.setVisible(this.visible);
    }

    /** Scales the distances where cells switch to simpler levels. */
    setLodScale(scale: number) {
        this.lodScale = Math.max(0.1, scale);
    }

    /**
     * Leaves out the cells beyond the draw distance from a camera at `eye`
     * (world), and gives each the level of detail its distance calls for
     * (with a margin, so a cell at a limit does not flicker between two).
     */
    update(eye: ArrayLike<number>) {
        if (!this.visible) return;
        for (const c of this.cells) {
            const d = boxDistance(c.min, c.max, eye);
            if (this.drawDistance > 0) {
                const on = d <= this.drawDistance;
                if (c.instancer.enable !== on) c.instancer.enable = on;
                if (!on) continue;
            }
            const near = Math.max(LOD_NEAR.meters, LOD_NEAR.radii * c.radius) * this.lodScale;
            const far = Math.max(LOD_FAR.meters, LOD_FAR.radii * c.radius) * this.lodScale;
            const level = levelAt(d, near, far, c.level);
            if (level === c.level) continue;
            c.level = level;
            // The instancer draws each group at its first renderer's level; all of them say the same.
            for (const r of c.renderers) r.lodLevel = level;
        }
    }

    /** What it draws, for the profiler: copies, cells shown and their levels of detail. */
    report(): string {
        const on = this.cells.filter((c) => c.instancer.enable);
        const levels = [0, 1, 2].map((l) => on.filter((c) => c.level === l).length);
        return `${this.count.toLocaleString('en-US')} copies, ${on.length}/${this.cells.length} cells (levels ${levels.join(' / ')})`;
    }

    /** The world box of every copy, or null without copies. */
    bounds(): { min: Vec3; max: Vec3 } | null {
        if (!this.cells.length) return null;
        const min: Vec3 = [Infinity, Infinity, Infinity];
        const max: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const c of this.cells) {
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], c.min[k]);
                max[k] = Math.max(max[k], c.max[k]);
            }
        }
        return { min, max };
    }

    /**
     * The nearest copy a ray meets within `maxDist`: cells, then the boxes
     * of their renderers, then `intersect` (triangles) on those it may hit.
     */
    hit(ray: Ray, maxDist: number, intersect: (r: RenderNode, ray: Ray) => number | null): { distance: number; renderer: RenderNode } | null {
        if (!this.visible) return null;
        let best: { distance: number; renderer: RenderNode } | null = null;
        const lo: Vec3 = [0, 0, 0], hi: Vec3 = [0, 0, 0];
        for (const c of this.cells) {
            const near = rayBox(ray, c.min, c.max);
            if (near === null || near > Math.min(maxDist, best?.distance ?? Infinity)) continue;
            for (let i = 0; i < c.renderers.length; i++) {
                for (let k = 0; k < 3; k++) {
                    lo[k] = c.boxes[i * 6 + k];
                    hi[k] = c.boxes[i * 6 + 3 + k];
                }
                const t0 = rayBox(ray, lo, hi);
                if (t0 === null || t0 > Math.min(maxDist, best?.distance ?? Infinity)) continue;
                const t = intersect(c.renderers[i], ray);
                if (t !== null && t <= maxDist && (!best || t < best.distance)) best = { distance: t, renderer: c.renderers[i] };
            }
        }
        return best;
    }

    private clear(dispose: (res: { destroy(force?: boolean): void }) => void) {
        for (const c of this.cells) {
            c.obj.removeFromParent();
            dispose(c.obj);
        }
        this.cells = [];
        this.count = 0;
    }

    dispose(dispose: (res: { destroy(force?: boolean): void }) => void) {
        this.clear(dispose);
        this.root.removeFromParent();
        this.root.destroy();
        dispose(this.ground);
    }
}

/** Grows `min`/`max` by a renderer's world box (its geometry's bounds turned by `m`) and appends that box to `out`. */
function boxOf(g: GeometryBase, m: ArrayLike<number>, min: Vec3, max: Vec3, out: number[]) {
    const b = g.bounds;
    const lo = b?.min, hi = b?.max;
    if (!lo || !hi || !(lo.x <= hi.x)) {
        out.push(m[12], m[13], m[14], m[12], m[13], m[14]);
        return;
    }
    const c = [(lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2];
    const e = [(hi.x - lo.x) / 2, (hi.y - lo.y) / 2, (hi.z - lo.z) / 2];
    const box = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 3; k++) {
        const center = m[k] * c[0] + m[4 + k] * c[1] + m[8 + k] * c[2] + m[12 + k];
        const reach = Math.abs(m[k]) * e[0] + Math.abs(m[4 + k]) * e[1] + Math.abs(m[8 + k]) * e[2];
        box[k] = center - reach;
        box[3 + k] = center + reach;
        min[k] = Math.min(min[k], box[k]);
        max[k] = Math.max(max[k], box[3 + k]);
    }
    out.push(...box);
}
