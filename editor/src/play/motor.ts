// Walking through a level with ray casts: the body of the walk camera and
// of characters (play/character.ts). It needs no physics engine: rays from
// the body find the walls in the way, the ground under it and the ceiling
// above it.

import type { RenderNode } from '@orillusion/core';
import { add, normalize, rayBox, scale, type Ray } from '../core/math';
import type { Store } from '../core/store';
import type { Vec3 } from '../core/types';
import { rendererWorldBox, type Box, type Picker } from '../engine/picking';
import type { SceneSync } from '../engine/sync';

/** Nearest hit of a ray within `maxDist` (dir need not be normalized), or null. */
export type CastFn = (origin: Vec3, dir: Vec3, maxDist: number) => { distance: number; point: Vec3 } | null;

/** A standing capsule: its height, radius and the highest step it climbs, in meters. */
export interface Body {
    height: number;
    radius: number;
    stepHeight: number;
}

const DOWN: Vec3 = [0, -1, 0];
const UP: Vec3 = [0, 1, 0];

/**
 * Moves a standing body through the level: it slides along walls, stops
 * where something would cut through it (a table top, a low beam), climbs
 * steps and ramps up to the step height, follows the ground down stairs,
 * falls with gravity and bumps its head on ceilings.
 */
export class CharacterMotor {
    /** Bottom center of the body. */
    feet: Vec3;
    /** Vertical speed, m/s. */
    vy = 0;
    /** Stood on something after the last step. */
    grounded = false;

    constructor(private cast: CastFn, public body: Body, feet: Vec3) {
        this.feet = [...feet] as Vec3;
    }

    /** Heights above the feet the wall rays go out at: from just over a step to the head. */
    private heights(): number[] {
        const b = this.body;
        const low = Math.min(b.stepHeight + 0.05, b.height * 0.5);
        const top = Math.max(low, b.height - 0.05);
        const n = Math.max(2, Math.ceil((top - low) / 0.35) + 1);
        return Array.from({ length: n }, (_, i) => low + ((top - low) * i) / (n - 1));
    }

    /** True when moving by `d` (horizontal) from the feet would run into something. */
    blocked(d: Vec3): boolean {
        const dist = Math.hypot(d[0], d[2]);
        if (dist < 1e-6) return false;
        const b = this.body;
        const dir: Vec3 = [d[0] / dist, 0, d[2] / dist];
        const side: Vec3 = [-dir[2], 0, dir[0]];
        // The center ray reaches the front of the body; the side rays its flanks.
        const rays: [number, number][] = [[0, b.radius], [0.7 * b.radius, 0.72 * b.radius], [-0.7 * b.radius, 0.72 * b.radius]];
        for (const hgt of this.heights()) {
            for (const [off, reach] of rays) {
                const origin: Vec3 = [this.feet[0] + side[0] * off, this.feet[1] + hgt, this.feet[2] + side[2] * off];
                if (this.cast(origin, dir, reach + dist)) return true;
            }
        }
        // Something thin and flat between the rays (a table top) would cut through the body there.
        const low = Math.min(b.stepHeight + 0.05, b.height * 0.5);
        return !!this.cast([this.feet[0] + d[0], this.feet[1] + low, this.feet[2] + d[2]], UP, Math.max(0.01, b.height - low - 0.02));
    }

    /**
     * One frame: moves by `move` (horizontal meters), sliding along walls,
     * then follows the ground or falls. A `jump` speed takes off from the
     * ground. Returns true when the body stands on something.
     */
    step(dt: number, move: Vec3, gravity: number, jump = 0): boolean {
        const b = this.body;
        if (move[0] && !this.blocked([move[0], 0, 0])) this.feet[0] += move[0];
        if (move[2] && !this.blocked([0, 0, move[2]])) this.feet[2] += move[2];

        // Follow the ground: climb steps up to the step height, fall otherwise.
        const probe = b.stepHeight + 0.3;
        const ground = this.vy <= 0 ? this.cast([this.feet[0], this.feet[1] + probe, this.feet[2]], DOWN, probe + Math.max(0.3, -this.vy * dt + 0.05)) : null;
        if (ground) {
            this.feet[1] = ground.point[1];
            this.vy = 0;
            this.grounded = true;
        } else {
            this.grounded = false;
            this.vy -= gravity * dt;
            let dy = this.vy * dt;
            if (dy > 0) {
                const head = this.cast([this.feet[0], this.feet[1] + b.height, this.feet[2]], UP, dy + 0.02);
                if (head) {
                    dy = Math.max(0, head.distance - 0.02);
                    this.vy = 0;
                }
            }
            this.feet[1] += dy;
        }
        if (jump > 0 && this.grounded) {
            this.vy = jump;
            this.grounded = false;
        }
        return this.grounded;
    }

    /** Height of the ground under a point within `depth`, or null. */
    groundAt(from: Vec3, depth: number): number | null {
        return this.cast(from, DOWN, depth)?.point[1] ?? null;
    }
}

/** A ray's nearest hit: the node it hit and the normal of the triangle there. */
export interface Hit {
    distance: number;
    point: Vec3;
    id: string;
    normal: Vec3;
}

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
    cast = (origin: Vec3, dir: Vec3, maxDist: number, ignore?: (id: string) => boolean): Hit | null => {
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
        let best: Hit | null = null;
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
