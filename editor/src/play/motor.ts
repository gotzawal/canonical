// Walking through a level with ray casts: the body of the walk camera and
// of the player controller. It needs no physics engine: rays from the body
// find the walls in the way, the ground under it and the ceiling above it.

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

/**
 * Ray casts against the shown meshes of the scene for a body moving through
 * it, leaving out the body's own objects. The renderers are collected now
 * and then (models load, scripts destroy objects) and their world boxes
 * once per frame, so the many rays of a frame test boxes first.
 */
export class LevelCollider {
    private items: { r: RenderNode; box: Box | null }[] = [];
    private age = Infinity;

    constructor(private picker: Picker, private sync: SceneSync, private store: Store, private skip: (id: string) => boolean = () => false) {}

    /** Call once per frame before casting. */
    refresh() {
        if (++this.age > 30) {
            this.age = 0;
            this.items = [];
            // Scripts may have destroyed an object: what was under it went with it.
            const gone = (id: string | null): boolean => !!id && (this.sync.detached.has(id) || gone(this.store.node(id)?.parent ?? null));
            for (const node of this.store.doc.nodes) {
                const entry = this.sync.entries.get(node.id);
                if (!entry || !entry.visible || this.skip(node.id) || gone(node.id)) continue;
                for (const r of this.sync.renderersOf(node.id)) if (r.enable) this.items.push({ r, box: null });
            }
        }
        for (const it of this.items) it.box = it.r.enable ? rendererWorldBox(it.r) : null;
    }

    cast: CastFn = (origin, dir, maxDist) => {
        const ray: Ray = { origin, dir: normalize(dir) };
        let best: { distance: number; point: Vec3 } | null = null;
        for (const it of this.items) {
            if (!it.box) continue;
            const near = rayBox(ray, it.box.min, it.box.max);
            if (near === null || near > maxDist || (best && near > best.distance)) continue;
            const t = this.picker.intersectRenderer(it.r, ray);
            if (t !== null && t >= 0 && t <= maxDist && (!best || t < best.distance)) best = { distance: t, point: add(origin, scale(ray.dir, t)) };
        }
        return best;
    };
}
