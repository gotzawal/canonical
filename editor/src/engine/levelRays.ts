// Ray casts against the shown meshes of the level, for characters in Play
// (play/character.ts) and the level check (design/levelCheck.ts).

import type { RenderNode } from '@orillusion/core';
import { add, normalize, rayBox, scale, type Ray, type RayHit } from '../core/math';
import type { Store } from '../core/store';
import type { Vec3 } from '../core/types';
import { rendererWorldBox, type Box, type Picker } from './picking';
import type { SceneSync } from './sync';

/**
 * Ray casts against the shown meshes of the level, with a grid over x and z
 * so short rays test few boxes. The level check builds it once; Play
 * refreshes it every frame, since characters and scripts move things, and
 * collects the meshes again now and then (models load, scripts destroy
 * objects). Every body passes the objects its rays leave out (its own).
 */
export class LevelRays {
    private items: { r: RenderNode; id: string; box: Box }[] = [];
    private grid = new Map<number, number[]>();
    /** Items too big for the grid (a ground plane): every ray tests them. */
    private huge: number[] = [];
    private stamp = new Uint32Array(0);
    private tick = 0;
    private age = Infinity;

    constructor(private picker: Picker, private sync: SceneSync, private store: Store, private skip: (id: string) => boolean = () => false, private cell = 2) {}

    /** Takes the boxes where the meshes are now; the meshes themselves are looked up every `every` calls. */
    refresh(every = 30) {
        if (++this.age >= every) {
            this.age = 0;
            this.items = [];
            // Scripts may have destroyed an object: what was under it went with it.
            const gone = (id: string | null): boolean => !!id && (this.sync.detached.has(id) || gone(this.store.node(id)?.parent ?? null));
            for (const node of this.store.doc.nodes) {
                if (!this.sync.entries.get(node.id)?.visible || this.skip(node.id) || gone(node.id)) continue;
                for (const r of this.sync.renderersOf(node.id)) if (r.enable) this.items.push({ r, id: node.id, box: null! });
            }
            this.stamp = new Uint32Array(this.items.length);
        }
        this.grid.clear();
        this.huge = [];
        const c = (v: number) => Math.floor(v / this.cell);
        this.items.forEach((it, i) => {
            const b = it.r.enable ? rendererWorldBox(it.r) : null;
            it.box = b ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
            if (!b) return;
            const [x0, x1, z0, z1] = [c(b.min[0]), c(b.max[0]), c(b.min[2]), c(b.max[2])];
            if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) return void this.huge.push(i);
            for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) this.bucket(x, z, true)!.push(i);
        });
    }

    private bucket(x: number, z: number, make = false): number[] | undefined {
        const k = (x + 32768) * 65536 + (z + 32768);
        let b = this.grid.get(k);
        if (!b && make) this.grid.set(k, (b = []));
        return b;
    }

    /** Nearest hit within `maxDist` (dir need not be normalized); `ignore` leaves objects out. */
    cast = (origin: Vec3, dir: Vec3, maxDist: number, ignore?: (id: string) => boolean): RayHit | null => {
        const d = normalize(dir);
        const ray: Ray = { origin, dir: d };
        const c = (v: number) => Math.floor(v / this.cell);
        const ex = origin[0] + d[0] * maxDist;
        const ez = origin[2] + d[2] * maxDist;
        const [x0, x1, z0, z1] = [c(Math.min(origin[0], ex)), c(Math.max(origin[0], ex)), c(Math.min(origin[2], ez)), c(Math.max(origin[2], ez))];
        let list: number[];
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 256) list = this.items.map((_, i) => i);
        else {
            list = [...this.huge];
            const t = ++this.tick;
            for (let x = x0; x <= x1; x++) {
                for (let z = z0; z <= z1; z++) {
                    for (const i of this.bucket(x, z) ?? []) {
                        if (this.stamp[i] === t) continue;
                        this.stamp[i] = t;
                        list.push(i);
                    }
                }
            }
        }
        let best: RayHit | null = null;
        const normal: Vec3 = [0, 0, 0];
        for (const i of list) {
            const it = this.items[i];
            if (ignore?.(it.id)) continue;
            const near = rayBox(ray, it.box.min, it.box.max);
            if (near === null || near > maxDist || (best && near > best.distance)) continue;
            const t = this.picker.intersectRenderer(it.r, ray, normal);
            if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.distance)) {
                best = { distance: t, point: add(origin, scale(d, t)), id: it.id, normal: [...normal] as Vec3 };
            }
        }
        return best;
    };
}
