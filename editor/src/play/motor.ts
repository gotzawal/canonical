// Walking through a level with ray casts: the body of the walk camera and
// of characters (play/character.ts). It needs no physics engine: rays from
// the body find the walls in the way, the ground under it and the ceiling
// above it.

import type { Vec3 } from '../core/types';

/** Nearest hit of a ray within `maxDist` (dir need not be normalized), or null; `normal`: the face's, `id`: the object's, where known. */
export type CastFn = (origin: Vec3, dir: Vec3, maxDist: number) => { distance: number; point: Vec3; normal?: Vec3; id?: string } | null;

/**
 * Open ground (terrains): which hits are on it, and rays that leave it out.
 * Walking over it, only its slope stops the body (judged under its feet,
 * as the level check does): its rays meet what stands on it, not the
 * ground rising beside it.
 */
export interface OpenGround {
    has(id: string | undefined): boolean;
    cast: CastFn;
}

/** A standing capsule: its height, radius and the highest step it climbs, in meters; the steepest slope it walks up, in degrees. */
export interface Body {
    height: number;
    radius: number;
    stepHeight: number;
    /** Steepest ground it walks up, degrees (MAX_SLOPE when missing). */
    maxSlope?: number;
}

/** The steepest slope a body walks up when it does not say, degrees (the Character component's default). */
export const MAX_SLOPE = 40;
/** Steep ground that rises no more than a step over this run (meters) is a step: a bank, a kerb. */
export const STEEP_RUN = 0.5;
/** Degrees a body climbs past its max slope over STEEP_RUN: ground the level check passes (sampled more coarsely) never stops it. */
const SLOPE_SLACK = 3;

const DOWN: Vec3 = [0, -1, 0];
const UP: Vec3 = [0, 1, 0];
const DEG = Math.PI / 180;

/** The steepest rise per meter a body walks up. */
export function climbRate(body: Body): number {
    return Math.tan(Math.min(89, Math.max(0, body.maxSlope ?? MAX_SLOPE)) * DEG);
}

/** The ground's normal leans too far for the body: steeper than its max slope. */
export function tooSteep(body: Body, normal: Vec3 | undefined): boolean {
    return !!normal && normal[1] < Math.cos(Math.atan(climbRate(body))) - 1e-4;
}

/**
 * Moves a standing body through the level: it slides along walls, stops
 * where something would cut through it (a table top, a low beam), climbs
 * steps up to the step height and slopes up to its max slope, follows the
 * ground down stairs and slopes, falls with gravity and bumps its head on
 * ceilings.
 */
export class CharacterMotor {
    /** Bottom center of the body. */
    feet: Vec3;
    /** Vertical speed, m/s. */
    vy = 0;
    /** Stood on something after the last step. */
    grounded = false;
    /** What it stands on is open ground (a terrain). */
    private onOpen = false;

    constructor(private cast: CastFn, public body: Body, feet: Vec3, private open?: OpenGround) {
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

    /**
     * True when moving by `d` (horizontal) from the feet would run into
     * something. `lean`: how much the ground rises per meter along the move
     * (a slope the body walks up): the rays rise with it, so they meet what
     * stands on the slope and not the slope itself. `overOpen`: the move
     * goes over open ground, which the rays leave out.
     */
    blocked(d: Vec3, lean = 0, overOpen = false): boolean {
        const dist = Math.hypot(d[0], d[2]);
        if (dist < 1e-6) return false;
        const b = this.body;
        const cast = overOpen && this.open ? this.open.cast : this.cast;
        const rise = Math.max(0, Math.min(lean, climbRate(b)));
        const len = Math.hypot(1, rise);
        const dir: Vec3 = [d[0] / dist / len, rise / len, d[2] / dist / len];
        const side: Vec3 = [-d[2] / dist, 0, d[0] / dist];
        // The center ray reaches the front of the body; the side rays its flanks.
        const rays: [number, number][] = [[0, b.radius], [0.7 * b.radius, 0.72 * b.radius], [-0.7 * b.radius, 0.72 * b.radius]];
        for (const hgt of this.heights()) {
            for (const [off, reach] of rays) {
                const origin: Vec3 = [this.feet[0] + side[0] * off, this.feet[1] + hgt, this.feet[2] + side[2] * off];
                if (cast(origin, dir, (reach + dist) * len)) return true;
            }
        }
        // Something thin and flat between the rays (a table top) would cut through the body there.
        const low = Math.min(b.stepHeight + 0.05, b.height * 0.5);
        return !!cast([this.feet[0] + d[0], this.feet[1] + rise * dist + low, this.feet[2] + d[2]], UP, Math.max(0.01, b.height - low - 0.02));
    }

    /**
     * The ground the feet would stand on after moving by `d` (horizontal):
     * how much higher it is (negative: lower), whether its surface slopes,
     * and whether it is a slope up steeper than the body climbs: its surface
     * leans more than the max slope, and over STEEP_RUN it rises past a step
     * and more steeply than the max slope (a lower bank is a step, a bump on
     * a gentler slope is not a cliff). `ahead`: how far it goes on this way
     * (it looks no farther). null without ground there from a step or a
     * slope above the feet to a short drop below.
     */
    ground(d: Vec3, ahead = Infinity): { rise: number; sloped: boolean; steep: boolean; open: boolean } | null {
        const b = this.body;
        const dist = Math.hypot(d[0], d[2]);
        const up = Math.max(b.stepHeight, dist * climbRate(b)) + 0.05;
        const hit = this.cast([this.feet[0] + d[0], this.feet[1] + up, this.feet[2] + d[2]], DOWN, up + 0.6);
        // A face looking down: the ray started inside something, which the wall rays meet.
        if (!hit || (hit.normal && hit.normal[1] < 0.3)) return null;
        const rise = hit.point[1] - this.feet[1];
        const sloped = !!hit.normal && hit.normal[1] < 0.9998;
        let steep = rise > 0.005 && tooSteep(b, hit.normal);
        if (steep && dist > 1e-6) {
            // Up to where its way turns, at most as much as over a whole run.
            const run = Math.max(Math.min(STEEP_RUN, ahead), dist);
            const most = Math.max(b.stepHeight + 0.05, Math.max(STEEP_RUN, dist) * Math.tan(Math.min(89, (b.maxSlope ?? MAX_SLOPE) + SLOPE_SLACK) * DEG));
            // From over the most it climbs there (a ray starting inside the ground meets it at once); nothing below is ground falling away.
            const far = this.cast([this.feet[0] + (d[0] / dist) * run, this.feet[1] + most + 0.05, this.feet[2] + (d[2] / dist) * run], DOWN, most + 0.65);
            steep = !!far && far.point[1] - this.feet[1] > most;
        }
        return { rise, sloped, steep, open: !!this.open?.has(hit.id) };
    }

    /** True when the body standing on the ground cannot move by `d`: a wall, or a slope up steeper than it climbs. */
    private stopped(d: Vec3, ahead: number): boolean {
        if (!this.grounded) return this.blocked(d);
        const g = this.ground(d, ahead);
        if (g?.steep) return true;
        return this.blocked(d, g && g.sloped && g.rise > 0 ? g.rise / Math.hypot(d[0], d[2]) : 0, this.onOpen && !!g?.open);
    }

    /**
     * One frame: moves by `move` (horizontal meters), sliding along walls,
     * then follows the ground or falls. A `jump` speed takes off from the
     * ground. `ahead`: how far it goes on this way (a walk along a planned
     * way, which turns there). Returns true when the body stands on
     * something.
     */
    step(dt: number, move: Vec3, gravity: number, jump = 0, ahead = Infinity): boolean {
        const b = this.body;
        if (move[0] && !this.stopped([move[0], 0, 0], ahead)) this.feet[0] += move[0];
        if (move[2] && !this.stopped([0, 0, move[2]], ahead)) this.feet[2] += move[2];

        // Follow the ground: climb steps up to the step height and slopes up and down to the max slope, fall otherwise.
        const slope = Math.hypot(move[0], move[2]) * climbRate(b);
        const probe = Math.max(b.stepHeight, slope) + 0.3;
        const ground = this.vy <= 0 ? this.cast([this.feet[0], this.feet[1] + probe, this.feet[2]], DOWN, probe + Math.max(0.3, slope + 0.05, -this.vy * dt + 0.05)) : null;
        if (ground) {
            this.feet[1] = ground.point[1];
            this.vy = 0;
            this.grounded = true;
            this.onOpen = !!this.open?.has(ground.id);
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
