// Characters (NodeDoc.character): the bodies the player and the NPCs walk
// through the level with. As with a pawn in Unreal, a character does what
// its controller asks each frame (the player's keys and camera, a behavior
// tree's Move To, a script): walk this way, run, jump, go to that object.
// Then all characters move at once, after the scripts' update, against one
// shared view of the level, and each stands in the others' way as an upright
// capsule. What they did is their state (velocity, on the ground, the mode,
// jump and land events) for whoever follows them: the player's camera,
// scripts, and animators, any number of them on each character.

import type { Object3D } from '@orillusion/core';
import { Emitter } from '../core/events';
import { add, DEG, invert, normalize, scale, transformPoint } from '../core/math';
import type { Store } from '../core/store';
import type { CharacterDoc, Vec3 } from '../core/types';
import type { Picker } from '../engine/picking';
import type { SceneSync } from '../engine/sync';
import { LevelRays } from '../engine/levelRays';
import { CharacterMotor, type CastFn, type OpenGround } from './motor';

/** How fast the body turns toward where it goes, per second. */
const TURN_RATE = 12;
/** A fall this far below the start puts the character back at the start. */
const FALL_LIMIT = 60;
/** A walk to a target gives up when it got no closer for this long, seconds. */
const STUCK_TIME = 2;

/** What a character is doing: standing, walking or running on the ground, going up or coming down in the air. */
export type CharacterMode = 'idle' | 'walk' | 'run' | 'jump' | 'fall';

export interface CharacterEvents {
    /** Took off. */
    jump: void;
    /** Came down on something, at this speed (m/s). */
    land: number;
    mode: CharacterMode;
}

interface Goal {
    target: Object3D | Vec3;
    radius: number;
    run: boolean;
    /** Straight at the target, without the planner. */
    straight: boolean;
    /** Corners still to pass on the planned way (the target comes after them). */
    path: Vec3[];
    /** Where the target was when the way was planned (null: not planned yet), and when. */
    plannedTo: Vec3 | null;
    plannedAt: number;
    best: number;
    since: number;
    done(arrived: boolean): void;
}

/** Plans a walk around walls: corner points from `from` to `to`, or null when there is no way. */
export type Planner = (from: Vec3, to: Vec3) => Vec3[] | null;

/** A corner this close counts as passed. */
const CORNER = 0.3;
/** The way is planned again when the target moved this far, at most every REPLAN seconds. */
const MOVED = 1;
const REPLAN = 0.5;

/** From angle a to angle b, degrees in -180..180. */
const turn = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;
/** World yaw of a matrix's forward axis (+z), degrees. */
const yawOf = (m: ArrayLike<number>) => (Math.hypot(m[8], m[10]) > 1e-6 ? Math.atan2(m[8], m[10]) / DEG : 0);

export class Character extends Emitter<CharacterEvents> {
    readonly motor: CharacterMotor;
    /** Runs instead of walking (kept until changed). */
    run = false;
    /** The way to face, degrees around y; null faces the way it walks. */
    face: number | null = null;
    /** The way the body faces, degrees around y (its +z points there). */
    facing: number;
    /** Movement in the last frame, m/s. */
    readonly velocity: Vec3 = [0, 0, 0];
    /** The horizontal velocity it tried to move at in the last frame, m/s. */
    readonly wanted: Vec3 = [0, 0, 0];
    /** Nodes its last move ran into (physics pushes the dynamic ones). */
    readonly bumped = new Set<string>();
    mode: CharacterMode = 'idle';
    /** Height of the object's origin above the feet. */
    readonly offset: number;
    private wish: [number, number] = [0, 0];
    private jumpWanted = false;
    private goal: Goal | null = null;
    private clock = 0;
    private start: Vec3;
    /** Plans walks to targets around walls (the level's navigation mesh, once Play has one); null walks straight. */
    planner: Planner | null = null;

    /** `bottom`: the lowest point of the object's meshes (null without meshes: its origin is the feet). `open`: the terrains it walks over. */
    constructor(readonly obj: Object3D, readonly doc: CharacterDoc, cast: CastFn, bottom: number | null, open?: OpenGround) {
        super();
        const m = obj.transform.worldMatrix.rawData;
        this.offset = bottom === null ? 0 : Math.max(0, m[13] - bottom);
        this.facing = yawOf(m);
        this.motor = new CharacterMotor(cast, doc, [m[12], m[13] - this.offset, m[14]], open);
        // Standing where it was placed: onto the ground under it.
        const feet = this.motor.feet;
        const ground = doc.collide ? this.motor.groundAt([feet[0], feet[1] + doc.stepHeight + 0.3, feet[2]], doc.stepHeight + 1.3) : null;
        if (ground !== null) {
            feet[1] = ground;
            this.motor.grounded = true;
        }
        this.start = [...feet] as Vec3;
        this.place();
    }

    get grounded(): boolean {
        return this.motor.grounded;
    }

    /** Speed over the ground, m/s. */
    get speed(): number {
        return Math.hypot(this.velocity[0], this.velocity[2]);
    }

    /** Bottom center of the body, world space. */
    get feet(): Vec3 {
        return this.motor.feet;
    }

    /** Walks this way this frame: a world direction (x, z) whose length is the share of full speed (up to 1). */
    move(x: number, z: number) {
        this.wish[0] += x;
        this.wish[1] += z;
    }

    /** Jumps when it stands on something. */
    jump() {
        this.jumpWanted = true;
    }

    /**
     * Walks to an object (following it) or a point until within `radius`:
     * around walls on the navigation mesh's way when there is one (planned
     * again as the target moves), else straight at it (`straight: true`
     * always), walls making it slide along or stop. Resolves true on
     * arrival, false when it got stuck, was stopped or got another target.
     */
    moveTo(target: Object3D | Vec3, opts: { radius?: number; run?: boolean; signal?: AbortSignal; straight?: boolean } = {}): Promise<boolean> {
        this.stop();
        return new Promise((resolve) => {
            const goal: Goal = {
                target,
                radius: Math.max(0.05, opts.radius ?? 1),
                run: !!opts.run,
                straight: !!opts.straight,
                path: [],
                plannedTo: null,
                plannedAt: -Infinity,
                best: Infinity,
                since: this.clock,
                done: (arrived) => {
                    if (this.goal === goal) this.goal = null;
                    resolve(arrived);
                },
            };
            this.goal = goal;
            if (opts.signal?.aborted) goal.done(false);
            opts.signal?.addEventListener('abort', () => goal.done(false), { once: true });
        });
    }

    /** Stops walking to a target. */
    stop() {
        this.goal?.done(false);
    }

    /** Turns the body to a point now; it keeps facing there until it walks. */
    lookAt(point: Vec3) {
        const f = this.motor.feet;
        if (Math.hypot(point[0] - f[0], point[2] - f[2]) > 1e-6) this.facing = (Math.atan2(point[0] - f[0], point[2] - f[2]) / DEG + 360) % 360;
    }

    /** One frame: moves as asked, then updates the state (Characters.update). */
    update(dt: number) {
        const d = this.doc;
        const motor = this.motor;
        const feet = motor.feet;
        // A script may have moved the object (a teleport): the body is where its object is.
        const m = this.obj.transform.worldMatrix.rawData;
        feet[0] = m[12];
        feet[2] = m[14];
        if (Math.abs(m[13] - this.offset - feet[1]) > 1e-4) {
            feet[1] = m[13] - this.offset;
            motor.vy = 0;
        }
        const before: Vec3 = [feet[0], feet[1], feet[2]];
        this.clock += dt;

        let run = this.run;
        const g = this.goal;
        if (g) {
            let to = g.target as Vec3;
            if (!Array.isArray(g.target)) {
                const w = g.target.transform.worldPosition;
                to = [w.x, w.y, w.z];
            }
            // The way around walls: planned at the start, again when the target moved away from where it leads.
            const planner = g.straight ? null : this.planner;
            if (planner && (g.plannedTo === null || (Math.hypot(to[0] - g.plannedTo[0], to[1] - g.plannedTo[1], to[2] - g.plannedTo[2]) > MOVED && this.clock - g.plannedAt > REPLAN))) {
                const corners = planner([feet[0], feet[1], feet[2]], to);
                g.plannedTo = to;
                g.plannedAt = this.clock;
                // The last corners at the target are the target itself; without a way it walks straight (and gets stuck).
                g.path = (corners ?? []).filter((c) => Math.hypot(c[0] - to[0], c[2] - to[2]) > g.radius);
                g.best = Infinity;
                g.since = this.clock;
            }
            while (g.path.length && Math.hypot(g.path[0][0] - feet[0], g.path[0][2] - feet[2]) < CORNER) {
                g.path.shift();
                g.best = Infinity;
                g.since = this.clock;
            }
            const aim = g.path[0] ?? to;
            const dx = aim[0] - feet[0];
            const dz = aim[2] - feet[2];
            const dist = Math.hypot(dx, dz);
            if (!g.path.length && dist <= g.radius) g.done(true);
            else if (dist > 1e-6) {
                this.move(dx / dist, dz / dist);
                run ||= g.run;
                // Getting closer to the next corner (or the target) is progress.
                if (dist < g.best - 0.1) {
                    g.best = dist;
                    g.since = this.clock;
                } else if (this.clock - g.since > STUCK_TIME) g.done(false);
            }
        }

        const [wx, wz] = this.wish;
        const len = Math.hypot(wx, wz);
        const k = ((run ? d.runSpeed : d.speed) * dt) / Math.max(1, len);
        const jump = this.jumpWanted && d.jump > 0 ? d.jump : 0;
        const wasGrounded = motor.grounded;
        const falling = -motor.vy;
        this.wanted[0] = dt > 0 ? (wx * k) / dt : 0;
        this.wanted[2] = dt > 0 ? (wz * k) / dt : 0;
        this.bumped.clear();
        this.wish = [0, 0];
        this.jumpWanted = false;
        if (d.collide) {
            motor.step(dt, [wx * k, 0, wz * k], d.gravity, jump);
            if (feet[1] < this.start[1] - FALL_LIMIT) {
                feet.splice(0, 3, ...this.start);
                motor.vy = 0;
            }
        } else {
            feet[0] += wx * k;
            feet[2] += wz * k;
        }

        // The body turns toward the way it is told to face, else where it walks.
        const want = this.face ?? (len > 1e-6 && k > 0 ? Math.atan2(wx, wz) / DEG : null);
        if (want !== null) this.facing = (this.facing + turn(this.facing, want) * Math.min(1, TURN_RATE * dt) + 360) % 360;

        for (let i = 0; i < 3; i++) this.velocity[i] = dt > 0 ? (feet[i] - before[i]) / dt : 0;
        const mode: CharacterMode = motor.grounded || !d.collide ? (this.speed < 0.1 ? 'idle' : this.speed > d.speed + 0.1 ? 'run' : 'walk') : motor.vy > 0 ? 'jump' : 'fall';
        if (jump && motor.vy === jump) this.emit('jump', undefined);
        if (!wasGrounded && motor.grounded && d.collide) this.emit('land', Math.max(0, falling));
        if (mode !== this.mode) {
            this.mode = mode;
            this.emit('mode', mode);
        }
        this.place();
    }

    /** Puts the object where the body is, turned the way it faces (in its parent's space). */
    private place() {
        const f = this.motor.feet;
        let p: Vec3 = [f[0], f[1] + this.offset, f[2]];
        let yaw = this.facing;
        const parent = this.obj.transform.parent?.object3D;
        if (parent && parent.transform.parent) {
            const pm = parent.transform.worldMatrix.rawData;
            const inv = invert(pm);
            if (inv) p = transformPoint(inv, p);
            yaw -= yawOf(pm);
        }
        this.obj.x = p[0];
        this.obj.y = p[1];
        this.obj.z = p[2];
        this.obj.rotationY = yaw;
    }
}

/** Where a ray meets a character's body (an upright cylinder) within `max`, or null. */
function hitBody(o: Vec3, dir: Vec3, c: Character, max: number): number | null {
    const d = normalize(dir);
    const f = c.feet;
    const r = c.doc.radius;
    const top = f[1] + c.doc.height;
    const ox = o[0] - f[0];
    const oz = o[2] - f[2];
    let best: number | null = null;
    // Its side, from outside.
    const a = d[0] * d[0] + d[2] * d[2];
    const b = ox * d[0] + oz * d[2];
    const disc = b * b - a * (ox * ox + oz * oz - r * r);
    if (a > 1e-9 && disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        const y = o[1] + t * d[1];
        if (t >= 0 && t <= max && y >= f[1] && y <= top) best = t;
    }
    // Its top and bottom, for rays from above (standing on a head) or below.
    if (Math.abs(d[1]) > 1e-9) {
        for (const y of [top, f[1]]) {
            const t = (y - o[1]) / d[1];
            const x = ox + t * d[0];
            const z = oz + t * d[2];
            if (t >= 0 && t <= max && (best === null || t < best) && x * x + z * z <= r * r) best = t;
        }
    }
    return best;
}

/**
 * The characters of a Play session. Their controllers go first (the
 * player's before the scripts' update; behavior trees and scripts during
 * it), then update() moves them all, before the scripts' lateUpdate.
 */
export class Characters {
    readonly list: Character[] = [];
    readonly rays: LevelRays;
    /** Nodes of the characters (and under them): the level leaves them out, their bodies stand in. */
    private own = new Set<string>();
    /** The terrains of the level, open ground (gathered again every frame). */
    private terrains = new Set<string>();
    private readonly land = (id: string | undefined) => !!id && this.terrains.has(id);

    constructor(picker: Picker, private sync: SceneSync, store: Store) {
        this.terrains = new Set(sync.terrains().map((t) => t.id));
        // Triggers (physics bodies that only detect) do not stop anyone.
        const trigger = (id: string) => {
            for (let n = store.node(id); n; n = n.parent ? store.node(n.parent) : undefined) if (n.body) return n.body.sensor;
            return false;
        };
        // It follows the level as scripts and physics move it (only what moved is boxed again).
        this.rays = new LevelRays(picker, sync, store, (id) => this.own.has(id) || trigger(id), { track: true });
    }

    /** Leaves these nodes out of the level (the characters' own): add all of them before the characters, so the level is collected once. */
    exclude(ids: readonly string[]) {
        let fresh = false;
        for (const id of ids) {
            if (this.own.has(id)) continue;
            this.own.add(id);
            fresh = true;
        }
        if (fresh) this.rays.invalidate();
    }

    /** Ray casts against the level without the characters (for cameras). */
    readonly level: CastFn = (o, d, m) => this.rays.cast(o, d, m);

    /** The character of an object; `nodes`: its node and the nodes under it. */
    add(obj: Object3D, doc: CharacterDoc, nodes: string[], bottom: number | null): Character {
        this.exclude(nodes);
        // Rays against the level (or what stands on its open ground) and the other characters' bodies.
        const rays = (ignore?: (id: string) => boolean): CastFn => (o, d, max) => {
            const hit = this.rays.cast(o, d, max, ignore);
            if (hit && !d[1]) c.bumped.add(hit.id);
            let best: ReturnType<CastFn> = hit;
            for (const other of this.list) {
                if (other.obj === obj) continue;
                // A ray of this length cannot reach a body whose axis is farther away than that (plus its radius).
                const reach = (best?.distance ?? max) + other.doc.radius;
                const f = other.feet;
                const dx = f[0] - o[0], dz = f[2] - o[2];
                if (dx * dx + dz * dz > reach * reach) continue;
                const t = hitBody(o, d, other, best?.distance ?? max);
                if (t !== null) best = { distance: t, point: add(o, scale(normalize(d), t)) };
            }
            return best;
        };
        const c = new Character(obj, doc, rays(), bottom, { has: this.land, cast: rays(this.land) });
        this.list.push(c);
        return c;
    }

    /** The character of an object, or of the nearest object above it that has one. */
    of(obj: Object3D | null): Character | null {
        for (let o = obj; o; o = o.transform.parent?.object3D ?? null) {
            const c = this.list.find((x) => x.obj === o);
            if (c) return c;
        }
        return null;
    }

    /** Destroyed objects take their characters with them, and leave the level. */
    remove(gone: Set<Object3D>) {
        for (const c of this.list.filter((x) => gone.has(x.obj))) {
            c.stop();
            this.list.splice(this.list.indexOf(c), 1);
        }
        this.rays.forget(gone);
    }

    update(dt: number) {
        this.rays.flush();
        this.terrains = new Set(this.sync.terrains().map((t) => t.id));
        for (const c of this.list) c.update(dt);
    }

    /** Stops following the level (Play stops). */
    dispose() {
        for (const c of this.list) c.stop();
        this.rays.dispose();
    }
}
