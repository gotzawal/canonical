// Ray casts against the shown meshes of the level, for characters in Play
// (play/character.ts), walking the level in the editor (viewport/walk.ts)
// and the level check (design/levelCheck.ts).

import type { Object3D, RenderNode } from '@orillusion/core';
import { add, invert, normalize, rayBox, scale, type Mat4, type Ray, type RayHit } from '../core/math';
import type { ChangeHint, Store } from '../core/store';
import { raySolid, solidBounds, type ScatterSolid } from '../core/scatter';
import { groundNormal, rayTerrain } from '../core/terrain';
import type { Vec3 } from '../core/types';
import { worldBoxInto, type Box, type Picker } from './picking';
import type { SceneSync } from './sync';
import { TransformWatch } from './transformWatch';

export interface LevelRaysOptions {
    /** Grid cell size over x and z, meters. */
    cell?: number;
    /**
     * Follows the level as it changes (Play, walking): only objects that
     * moved are boxed again, and the meshes are collected again when the
     * document changes or a model loads. Call dispose() when done. Without
     * it, refresh() takes the level as it is (the level check).
     */
    track?: boolean;
}

interface Item {
    r: RenderNode;
    id: string;
    box: Box;
    /** Whether `box` holds the renderer (false without usable bounds). */
    boxed: boolean;
    /** Inverse of its world matrix, made when a ray first needs it after a move. */
    inv: Mat4 | null;
    /** The geometry it was boxed with (a script may swap it). */
    geo: unknown;
    /** Grid cells it is filed in, [x0, x1, z0, z1]; null when in `huge` or nowhere. */
    cells: [number, number, number, number] | null;
    huge: boolean;
    /** Destroyed by a script: out until the level is collected again. */
    dead: boolean;
}

/**
 * Ray casts against the shown meshes of the level, with a grid over x and z
 * so short rays test few boxes. Every body passes the objects its rays
 * leave out (its own).
 */
export class LevelRays {
    private items: Item[] = [];
    private grid = new Map<number, number[]>();
    /** Items too big for the grid (a ground plane): every ray tests them. */
    private huge: number[] = [];
    private stamp = new Uint32Array(0);
    private tick = 0;
    /** Solid copies of scatters (trunks, boxes), on a grid of their own. */
    private solids: { id: string; s: ScatterSolid }[] = [];
    private solidGrid = new Map<number, number[]>();
    private solidStamp = new Uint32Array(0);
    private age = Infinity;
    private readonly cell: number;
    /** Tracking: the objects of the items, keyed by item index. */
    private watch: TransformWatch<number> | null = null;
    /** Tracking: the meshes are collected again before the next ray. */
    private stale = true;
    private offs: (() => void)[] = [];

    constructor(private picker: Picker, private sync: SceneSync, private store: Store, private skip: (id: string) => boolean = () => false, opts: LevelRaysOptions = {}) {
        this.cell = opts.cell ?? 2;
        if (opts.track) {
            this.watch = new TransformWatch<number>();
            const onChange = (hint: ChangeHint | undefined) => {
                // Moves arrive as transform events; other edits may add, remove or reshape meshes.
                if (hint && (hint.transform || hint.meta || hint.design || hint.behavior || (hint.env && !hint.nodes))) return;
                this.stale = true;
            };
            const invalidate = () => (this.stale = true);
            this.offs.push(store.on('change', onChange), store.on('load', invalidate), sync.on('model', invalidate), sync.on('scatter', invalidate));
        }
    }

    /** Collects the meshes again before the next ray (new objects to leave out, for one). */
    invalidate() {
        this.stale = true;
        this.age = Infinity;
    }

    /**
     * Brings the boxes up to date. Tracking, this boxes again only what
     * moved (rays call it themselves); otherwise it boxes everything, and
     * collects the meshes again every `every` calls.
     */
    refresh(every = 30) {
        if (this.watch) {
            this.flush();
            return;
        }
        if (++this.age >= every) {
            this.age = 0;
            this.collect();
        }
        this.grid.clear();
        this.huge = [];
        for (let i = 0; i < this.items.length; i++) {
            this.items[i].cells = null;
            this.items[i].huge = false;
            this.place(i);
        }
    }

    /** Tracking: collects the meshes when the level changed, and boxes again the objects that moved. */
    flush() {
        const watch = this.watch;
        if (!watch) return;
        if (this.stale) {
            this.stale = false;
            this.collect();
            for (let i = 0; i < this.items.length; i++) this.place(i);
            return;
        }
        if (!watch.moved.size) return;
        for (const i of watch.moved) this.place(i);
        watch.moved.clear();
    }

    /** Leaves destroyed objects out at once (they would also go at the next collection). */
    forget(objs: Set<Object3D>) {
        for (let i = 0; i < this.items.length; i++) {
            const it = this.items[i];
            if (it.dead || !objs.has(it.r.object3D)) continue;
            this.unfile(i);
            it.dead = true;
        }
    }

    /** Stops tracking (the listeners on the level's objects outlive them otherwise). */
    dispose() {
        this.watch?.clear();
        for (const off of this.offs) off();
        this.offs = [];
        this.items = [];
        this.grid.clear();
        this.huge = [];
    }

    /** The shown meshes of the level that no body leaves out; watched while tracking. */
    private collect() {
        this.watch?.clear();
        this.items = [];
        this.grid.clear();
        this.huge = [];
        for (const node of this.store.doc.nodes) {
            if (!this.sync.entries.get(node.id)?.visible || this.skip(node.id) || this.gone(node.id)) continue;
            for (const r of this.sync.renderersOf(node.id)) {
                const i = this.items.length;
                this.items.push({ r, id: node.id, box: { min: [0, 0, 0], max: [0, 0, 0] }, boxed: false, inv: null, geo: null, cells: null, huge: false, dead: false });
                if (this.watch && r.object3D) this.watch.watch(r.object3D, i);
            }
        }
        this.stamp = new Uint32Array(this.items.length);
        this.watch?.moved.clear();
        this.collectSolids();
    }

    /** The solid copies of the shown scatters no body leaves out, filed by the cells their boxes cover. */
    private collectSolids() {
        this.solids = [];
        this.solidGrid.clear();
        for (const { id, solids } of this.sync.scatterSolids()) {
            if (this.skip(id) || this.gone(id)) continue;
            for (const s of solids) {
                const i = this.solids.length;
                this.solids.push({ id, s });
                const b = solidBounds(s);
                const c = (v: number) => Math.floor(v / this.cell);
                for (let x = c(b.min[0]); x <= c(b.max[0]); x++) {
                    for (let z = c(b.min[2]); z <= c(b.max[2]); z++) {
                        const k = (x + 32768) * 65536 + (z + 32768);
                        let list = this.solidGrid.get(k);
                        if (!list) this.solidGrid.set(k, (list = []));
                        list.push(i);
                    }
                }
            }
        }
        this.solidStamp = new Uint32Array(this.solids.length);
    }

    /** Destroyed by a script, or under something that was. */
    private gone(id: string | null): boolean {
        return !!id && (this.sync.detached.has(id) || this.gone(this.store.node(id)?.parent ?? null));
    }

    /** Boxes an item where it is now and files it in the grid. */
    private place(i: number) {
        const it = this.items[i];
        if (it.dead) return;
        if (this.watch && (this.gone(it.id) || !it.r.object3D)) {
            this.unfile(i);
            it.dead = true;
            return;
        }
        it.geo = it.r.geometry;
        it.inv = null;
        it.boxed = worldBoxInto(it.r, it.box);
        if (!it.boxed) {
            this.unfile(i);
            return;
        }
        const c = (v: number) => Math.floor(v / this.cell);
        const x0 = c(it.box.min[0]), x1 = c(it.box.max[0]), z0 = c(it.box.min[2]), z1 = c(it.box.max[2]);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) {
            if (it.huge) return;
            this.unfile(i);
            it.huge = true;
            this.huge.push(i);
            return;
        }
        const cells = it.cells;
        if (cells && cells[0] === x0 && cells[1] === x1 && cells[2] === z0 && cells[3] === z1) return;
        this.unfile(i);
        it.cells = [x0, x1, z0, z1];
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) this.bucket(x, z, true)!.push(i);
    }

    /** Takes an item out of the grid (or the huge list). */
    private unfile(i: number) {
        const it = this.items[i];
        const drop = (list: number[]) => {
            const k = list.indexOf(i);
            if (k < 0) return;
            list[k] = list[list.length - 1];
            list.pop();
        };
        if (it.huge) {
            drop(this.huge);
            it.huge = false;
        }
        if (it.cells) {
            const [x0, x1, z0, z1] = it.cells;
            for (let x = x0; x <= x1; x++) {
                for (let z = z0; z <= z1; z++) {
                    const b = this.bucket(x, z);
                    if (b) drop(b);
                }
            }
            it.cells = null;
        }
    }

    private bucket(x: number, z: number, make = false): number[] | undefined {
        const k = (x + 32768) * 65536 + (z + 32768);
        let b = this.grid.get(k);
        if (!b && make) this.grid.set(k, (b = []));
        return b;
    }

    /** Nearest hit within `maxDist` (dir need not be normalized); `ignore` leaves objects out. */
    cast = (origin: Vec3, dir: Vec3, maxDist: number, ignore?: (id: string) => boolean): RayHit | null => {
        if (this.watch) this.flush();
        const d = normalize(dir);
        const ray: Ray = { origin, dir: d };
        const c = (v: number) => Math.floor(v / this.cell);
        const ex = origin[0] + d[0] * maxDist;
        const ez = origin[2] + d[2] * maxDist;
        const x0 = c(Math.min(origin[0], ex)), x1 = c(Math.max(origin[0], ex)), z0 = c(Math.min(origin[2], ez)), z1 = c(Math.max(origin[2], ez));
        let best: RayHit | null = null;
        const normal: Vec3 = [0, 0, 0];
        const test = (i: number) => {
            const it = this.items[i];
            if (it.dead || !this.sync.shown(it.r) || (ignore && ignore(it.id))) return;
            if (it.r.geometry !== it.geo) {
                // A script swapped its shape: box it again now; it is filed again with the next flush.
                it.geo = it.r.geometry;
                it.inv = null;
                it.boxed = worldBoxInto(it.r, it.box);
                this.watch?.moved.add(i);
            }
            if (!it.boxed) return;
            const near = rayBox(ray, it.box.min, it.box.max);
            if (near === null || near > maxDist || (best && near > best.distance)) return;
            if (!it.inv) it.inv = it.r.object3D ? invert(it.r.object3D.transform.worldMatrix.rawData) : null;
            if (!it.inv) return;
            const t = this.picker.intersectRenderer(it.r, ray, normal, it.inv);
            if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.distance)) {
                best = { distance: t, point: add(origin, scale(d, t)), id: it.id, normal: [...normal] as Vec3 };
            }
        };
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 256) {
            // A long ray: every item.
            for (let i = 0; i < this.items.length; i++) test(i);
            for (let i = 0; i < this.solids.length; i++) best = this.solidHit(i, origin, d, maxDist, best, ignore);
            return this.terrainHit(origin, d, maxDist, best, ignore);
        }
        const t = ++this.tick;
        for (const i of this.huge) {
            this.stamp[i] = t;
            test(i);
        }
        for (let x = x0; x <= x1; x++) {
            for (let z = z0; z <= z1; z++) {
                const b = this.bucket(x, z);
                if (!b) continue;
                for (let k = 0; k < b.length; k++) {
                    const i = b[k];
                    if (this.stamp[i] === t) continue;
                    this.stamp[i] = t;
                    test(i);
                }
            }
        }
        if (this.solids.length) {
            for (let x = x0; x <= x1; x++) {
                for (let z = z0; z <= z1; z++) {
                    const list = this.solidGrid.get((x + 32768) * 65536 + (z + 32768));
                    if (!list) continue;
                    for (const i of list) {
                        if (this.solidStamp[i] === t) continue;
                        this.solidStamp[i] = t;
                        best = this.solidHit(i, origin, d, maxDist, best, ignore);
                    }
                }
            }
        }
        return this.terrainHit(origin, d, maxDist, best, ignore);
    };

    /** The hit, or a solid copy's when the ray (`d` unit length) meets it first. */
    private solidHit(i: number, origin: Vec3, d: Vec3, maxDist: number, best: RayHit | null, ignore?: (id: string) => boolean): RayHit | null {
        const { id, s } = this.solids[i];
        if (ignore?.(id)) return best;
        const hit = raySolid(s, origin, d, Math.min(maxDist, best?.distance ?? Infinity));
        if (!hit) return best;
        return { distance: hit.t, point: add(origin, scale(d, hit.t)), id, normal: hit.normal };
    }

    /** The hit, or a terrain one meets first (from its heightmap; terrains that do not collide are left out). */
    private terrainHit(origin: Vec3, d: Vec3, maxDist: number, best: RayHit | null, ignore?: (id: string) => boolean): RayHit | null {
        for (const t of this.sync.terrains()) {
            if (!t.collide || ignore?.(t.id)) continue;
            const hit = rayTerrain(t.surface, origin, d, Math.min(maxDist, best?.distance ?? Infinity));
            if (hit === null || hit < 0) continue;
            const point = add(origin, scale(d, hit));
            best = { distance: hit, point, id: t.id, normal: groundNormal(t.surface, point[0], point[2]) };
        }
        return best;
    }
}
