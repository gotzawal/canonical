// Physics in Play (NodeDoc.body), simulated by Rapier. Its package
// (@dimforge/rapier3d-compat, WebAssembly inside) loads the first time a
// scene needs it. Dynamic bodies fall, collide and bounce, and move their
// objects; kinematic bodies follow their objects (scripts move them) and
// push dynamic ones; fixed bodies, and the shown meshes without a body (the
// level), stay with their objects. Characters keep walking with their own
// motor and stand in as kinematic capsules a little wider than their bodies,
// so walking into a crate pushes it. Scripts hear of collisions and triggers
// (onCollisionEnter...) and move bodies through this.body.

import type * as RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, VertexAttributeName, type Object3D, type RenderNode } from '@orillusion/core';
import { compose, decompose, DEG, invert, mul, normalize, quatFromEuler, transformPoint, type Mat4, type Quat, type Vec3 } from '../core/math';
import { Body } from '../core/model';
import type { Store } from '../core/store';
import type { TerrainSurface } from '../core/terrain';
import type { BodyDoc, BodyType, GeometryDoc, NodeDoc, SceneDoc } from '../core/types';
import type { SceneSync } from '../engine/sync';
import { TransformWatch } from '../engine/transformWatch';
import type { Character } from './character';

export type Rapier = typeof RAPIER;

/** Down, m/s². */
const GRAVITY = 9.81;
/** Characters push from this far outside their bodies. */
const REACH = 0.06;
/** Half the thickness of the slab under a plane. */
const SLAB = 0.05;
/** Steps of at most 1/60 s, up to this many a frame. */
const MAX_STEPS = 6;
/** Characters push bodies up to this mass (kg) at their own speed, heavier ones slower. */
const PUSH_MASS = 80;

let loading: Promise<Rapier | null> | null = null;
/** Rapier once it has loaded, null when it could not, undefined before. */
let loaded: Rapier | null | undefined;

/** True when Play needs physics: an object has a body, or a script talks to physics. */
export function usesPhysics(doc: SceneDoc): boolean {
    return doc.nodes.some((n) => n.body) || doc.scripts.some((s) => /\bthis\.(body|physics)\b|\bbody\s*:/.test(s.code));
}

/** Loads Rapier once; resolves when it can simulate, or with null when it cannot be loaded. */
export function loadPhysics(): Promise<Rapier | null> {
    loading ??= import('@dimforge/rapier3d-compat')
        .then(async (R) => {
            // Its WebAssembly loader complains about how Rapier calls it; nothing to act on.
            const warn = console.warn;
            console.warn = (...args: unknown[]) => void (String(args[0]).includes('deprecated parameters') || warn(...args));
            try {
                await R.init();
            } finally {
                console.warn = warn;
            }
            return (loaded = R);
        })
        .catch((e) => {
            console.warn('[physics] Rapier could not be loaded; Play runs without physics.', e);
            return (loaded = null);
        });
    return loading;
}

/** Starts loading Rapier when the scene will need it, so Play has it at once. */
export function preloadPhysics(doc: SceneDoc) {
    if (!loading && usesPhysics(doc)) void loadPhysics();
}

/** Rapier once it has loaded, null when it could not, undefined before. */
export const physicsLoaded = (): Rapier | null | undefined => loaded;

export type VecLike = Vec3 | { x: number; y: number; z: number };

/** What a script sees of its object's body (this.body). */
export interface BodyApi {
    readonly type: BodyType;
    readonly mass: number;
    /** m/s, world space. */
    velocity: Vec3;
    /** Degrees per second around the world axes. */
    angularVelocity: Vec3;
    /** Changes its momentum at once (kg·m/s): a kick, a jump, a hit. */
    applyImpulse(impulse: VecLike): void;
    /** Changes its spin at once (kg·m²/s). */
    applyTorqueImpulse(impulse: VecLike): void;
    /** Puts it at a world position (and rotation, Euler degrees) at once, keeping its velocity. */
    teleport(position: VecLike, rotation?: VecLike): void;
    readonly sleeping: boolean;
    wakeUp(): void;
}

export interface RaycastHit {
    object: Object3D;
    point: Vec3;
    normal: Vec3;
    distance: number;
}

/** What a script sees of the physics world (this.physics). */
export interface PhysicsApi {
    /** m/s², [0, -9.81, 0] at first. */
    gravity: Vec3;
    /** The first collider along a ray (triggers left out), not counting the colliders of `ignore`. */
    raycast(origin: VecLike, direction: VecLike, maxDistance?: number, ignore?: Object3D): RaycastHit | null;
}

/** What physics needs from Play mode. */
export interface PhysicsHost {
    readonly store: Store;
    readonly sync: SceneSync;
    /** The characters of the session. */
    characters(): readonly Character[];
    /** Tells an object's scripts about a collision or a trigger (onCollisionEnter, onTriggerExit...). */
    notify(obj: Object3D, method: string, other: Object3D): void;
}

interface Item {
    obj: Object3D;
    body: RAPIER.RigidBody;
    type: BodyType;
    /** The body's settings; null for the level and characters. */
    doc: BodyDoc | null;
    /** Where physics last put the object or found it (world), to notice scripts moving it. */
    pos: Vec3;
    rot: Quat;
    character?: Character;
    /** Height of a character's capsule center above its feet. */
    lift?: number;
    api?: BodyApi;
}

/** A collider in its body's frame, with the scale applied. */
type Shape =
    | { kind: 'cuboid'; half: Vec3; at: Vec3 }
    | { kind: 'ball'; radius: number; at: Vec3 }
    | { kind: 'capsule' | 'cylinder' | 'cone'; half: number; radius: number; at: Vec3 }
    | { kind: 'hull'; points: Float32Array }
    | { kind: 'mesh'; points: Float32Array; indices: Uint32Array };

const xyz = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
const xyzw = (q: Quat) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
const vec = (v: VecLike): Vec3 => (Array.isArray(v) ? [+v[0] || 0, +v[1] || 0, +v[2] || 0] : [+v.x || 0, +v.y || 0, +v.z || 0]);
/** True when a pose differs from the one physics knows by more than float32 matrices lose (q and -q are one rotation). */
const moved = (it: Item, p: Vec3, q: Quat) =>
    p.some((x, i) => Math.abs(x - it.pos[i]) > 1e-5 + 1e-6 * Math.abs(x)) || Math.abs(q[0] * it.rot[0] + q[1] * it.rot[1] + q[2] * it.rot[2] + q[3] * it.rot[3]) < 1 - 1e-8;
const SCRATCH = new Quaternion();

/** The exact collider of a primitive with this scale; null for shapes that need their triangles. */
export function primitiveShape(g: GeometryDoc, s: Vec3): Shape | null {
    const [sx, sy, sz] = s.map(Math.abs);
    const xz = Math.max(sx, sz);
    const at: Vec3 = [0, 0, 0];
    switch (g.type) {
        case 'box':
            return { kind: 'cuboid', half: [(g.width / 2) * sx, (g.height / 2) * sy, (g.depth / 2) * sz], at };
        case 'plane':
            return { kind: 'cuboid', half: [(g.width / 2) * sx, SLAB, (g.height / 2) * sz], at: [0, -SLAB, 0] };
        case 'sphere':
            return { kind: 'ball', radius: g.radius * Math.max(sx, sy, sz), at };
        case 'capsule':
            return { kind: 'capsule', half: Math.max(0, (g.height * sy) / 2 - g.radius * xz), radius: g.radius * xz, at };
        case 'cylinder':
            return g.radiusTop === g.radiusBottom ? { kind: 'cylinder', half: (g.height * sy) / 2, radius: g.radiusTop * xz, at } : null;
        case 'cone':
            // Up to 8 segments its sides are flat: the hull fits better.
            return g.segments > 8 ? { kind: 'cone', half: (g.height * sy) / 2, radius: g.radius * xz, at } : null;
        default:
            return null;
    }
}

/** The collider a body gets: `own` is its primitive's exact shape, `mesh` its triangles in its frame. */
export function fitShape(shape: BodyDoc['shape'], type: BodyType, own: Shape | null, mesh: () => { points: Float32Array; indices: Uint32Array }): Shape | null {
    if (shape === 'auto' && own) return own;
    const { points, indices } = mesh();
    if (points.length < 12) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i++) {
        min[i % 3] = Math.min(min[i % 3], points[i]);
        max[i % 3] = Math.max(max[i % 3], points[i]);
    }
    const at = min.map((v, i) => (v + max[i]) / 2) as Vec3;
    const half = min.map((v, i) => Math.max(0.005, (max[i] - v) / 2)) as Vec3;
    switch (shape) {
        case 'box':
            return { kind: 'cuboid', half, at };
        case 'sphere':
            return { kind: 'ball', radius: Math.max(...half), at };
        case 'capsule': {
            const radius = Math.max(half[0], half[2]);
            return { kind: 'capsule', half: Math.max(0, half[1] - radius), radius, at };
        }
        case 'hull':
            return { kind: 'hull', points };
        default:
            // Dynamic bodies behave with a hull; the level and kinematic bodies keep their triangles.
            return type === 'dynamic' ? { kind: 'hull', points } : { kind: 'mesh', points, indices };
    }
}

/** The vertices and triangles of meshes in a body's frame (`inv` takes world space there). */
function gather(renderers: RenderNode[], inv: Mat4): { points: Float32Array; indices: Uint32Array } {
    const points: number[] = [];
    const indices: number[] = [];
    for (const r of renderers) {
        const pos = r.geometry?.getAttribute(VertexAttributeName.position)?.data as ArrayLike<number> | undefined;
        if (!pos || !r.object3D) continue;
        const m = mul(inv, r.object3D.transform.worldMatrix.rawData);
        const base = points.length / 3;
        for (let i = 0; i + 2 < pos.length; i += 3) points.push(...transformPoint(m, [pos[i], pos[i + 1], pos[i + 2]]));
        const idx = r.geometry.getAttribute(VertexAttributeName.indices)?.data as ArrayLike<number> | undefined;
        const count = points.length / 3 - base;
        if (idx) for (let i = 0; i < idx.length; i++) idx[i] < count && indices.push(base + idx[i]);
        else for (let i = 0; i < count; i++) indices.push(base + i);
    }
    return { points: new Float32Array(points), indices: new Uint32Array(indices.slice(0, indices.length - (indices.length % 3))) };
}

function colliderDesc(R: Rapier, s: Shape): RAPIER.ColliderDesc | null {
    switch (s.kind) {
        case 'cuboid':
            return R.ColliderDesc.cuboid(...(s.half.map((v) => Math.max(0.005, v)) as Vec3)).setTranslation(...s.at);
        case 'ball':
            return R.ColliderDesc.ball(Math.max(0.005, s.radius)).setTranslation(...s.at);
        case 'capsule':
        case 'cylinder':
        case 'cone':
            return R.ColliderDesc[s.kind](Math.max(0.005, s.half), Math.max(0.005, s.radius)).setTranslation(...s.at);
        case 'hull':
            return R.ColliderDesc.convexHull(s.points);
        case 'mesh':
            return s.indices.length ? R.ColliderDesc.trimesh(s.points, s.indices) : null;
    }
}

/** The physics world of one Play session. */
export class Physics implements PhysicsApi {
    private world: RAPIER.World;
    private queue: RAPIER.EventQueue;
    private items = new Map<Object3D, Item>();
    /** Collider handle -> what it belongs to. */
    private owners = new Map<number, Item>();
    /** Node id -> the body its meshes belong to (what characters run into). */
    private nodes = new Map<string, Item>();
    /** The bodies of objects that moved (scripts, physics, a moved parent); only they are followed. */
    private moves = new TransformWatch<Item>();
    private chars: Item[] = [];

    constructor(private R: Rapier, private host: PhysicsHost) {
        this.world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
        this.queue = new R.EventQueue(true);
        const { store, sync } = host;
        // A body takes the meshes under it that have none; a character keeps its own out of the level.
        const holder = (id: string) => {
            for (let n = store.node(id); n; n = n.parent ? store.node(n.parent) : undefined) if (n.body || n.character) return n;
            return null;
        };
        // Hidden objects are out of the game, but a trigger is usually an unseen volume.
        const shown = store.doc.nodes.filter((n) => (sync.entries.get(n.id)?.visible || n.body?.sensor) && !sync.detached.has(n.id));
        const held = new Map<string, NodeDoc[]>();
        for (const m of shown) {
            const h = holder(m.id);
            if (h) held.set(h.id, [...(held.get(h.id) ?? []), m]);
        }
        // Terrains stand as heightfields of their maps, whatever detail their chunks draw.
        const lands = new Map(sync.terrains().filter((t) => t.collide).map((t) => [t.id, t.surface]));
        for (const n of shown) {
            if (n.terrain) {
                const land = lands.get(n.id);
                if (land) this.addTerrain(n.id, sync.entries.get(n.id)!.obj, land);
                continue;
            }
            const owner = holder(n.id);
            if ((owner && owner !== n) || n.character) continue;
            const parts = n.body ? (held.get(n.id) ?? []) : [n];
            const obj = sync.entries.get(n.id)!.obj;
            if (this.add(obj, n.body ?? null, parts.flatMap((m) => sync.renderersOf(m.id)), n.mesh?.geometry)) for (const m of parts) this.nodes.set(m.id, this.items.get(obj)!);
            else if (n.body) console.warn(`[physics] ${n.name} has nothing to collide with.`);
        }
        for (const c of host.characters()) this.addCharacter(c);
    }

    /** Gives an object a body (null: a fixed part of the level) from `renderers`; `geometry` is its own primitive. False when nothing collides. */
    add(obj: Object3D, doc: BodyDoc | null, renderers: RenderNode[], geometry?: GeometryDoc): boolean {
        if (!renderers.length) return false;
        const R = this.R;
        const type = doc?.type ?? 'fixed';
        const { position, rotation, scale } = decompose(obj.transform.worldMatrix.rawData);
        const inv = invert(compose(position, rotation, [1, 1, 1]))!;
        const own = geometry && renderers.length === 1 && renderers[0].object3D === obj ? primitiveShape(geometry, scale) : null;
        const shape = fitShape(doc?.shape ?? 'auto', type, own, () => gather(renderers, inv));
        const desc = shape && colliderDesc(R, shape);
        if (!desc) return false;
        const bd = type === 'dynamic' ? R.RigidBodyDesc.dynamic() : type === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed();
        bd.setTranslation(...position).setRotation(xyzw(rotation));
        if (doc) {
            bd.setLinearDamping(doc.drag).setAngularDamping(doc.angularDrag).setGravityScale(doc.gravity).setCcdEnabled(doc.fast);
            if (doc.lockRotation) bd.lockRotations();
            desc.setMass(doc.mass).setFriction(doc.friction).setRestitution(doc.bounce).setSensor(doc.sensor);
            // Triggers notice characters and the level too.
            if (doc.sensor) desc.setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
        }
        this.track({ obj, body: this.world.createRigidBody(bd), type, doc, pos: position, rot: rotation }, desc);
        return true;
    }

    /** A terrain's heights as a fixed heightfield (Rapier's: columns along +x, rows along +z, centered on the body). */
    private addTerrain(id: string, obj: Object3D, s: TerrainSurface) {
        const map = s.map;
        if (!map) return;
        const w = map.width;
        const h = map.height;
        const heights = new Float32Array(w * h);
        for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) heights[x * h + z] = map.data[z * w + x];
        const f = s.frame;
        const desc = this.R.ColliderDesc.heightfield(h - 1, w - 1, heights, { x: f.sizeX, y: f.height, z: f.sizeZ }, this.R.HeightFieldFlags.FIX_INTERNAL_EDGES);
        const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(f.x, f.y, f.z));
        this.track({ obj, body, type: 'fixed', doc: null, pos: [f.x, f.y, f.z], rot: [0, 0, 0, 1] }, desc);
        this.nodes.set(id, this.items.get(obj)!);
    }

    /** A character's capsule: from just above its feet to the top of its head, REACH wider. */
    private addCharacter(c: Character) {
        if (!c.doc.collide) return;
        const radius = c.doc.radius + REACH;
        const height = c.doc.height - 0.02;
        const half = Math.max(0.01, height / 2 - radius);
        const lift = 0.02 + height / 2;
        const f = c.feet;
        const body = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(f[0], f[1] + lift, f[2]));
        this.track({ obj: c.obj, body, type: 'kinematic', doc: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], character: c, lift }, this.R.ColliderDesc.capsule(half, radius));
    }

    private track(it: Item, desc: RAPIER.ColliderDesc) {
        const collider = this.world.createCollider(desc.setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS), it.body);
        this.items.set(it.obj, it);
        this.owners.set(collider.handle, it);
        if (it.character) this.chars.push(it);
        else this.moves.watch(it.obj, it);
    }

    /** Destroyed objects take their bodies with them. */
    remove(gone: Set<Object3D>) {
        for (const it of Array.from(this.items.values())) {
            if (!gone.has(it.obj)) continue;
            this.items.delete(it.obj);
            this.moves.unwatch(it.obj);
            this.moves.moved.delete(it);
            if (it.character) this.chars.splice(this.chars.indexOf(it), 1);
            for (let i = 0; i < it.body.numColliders(); i++) this.owners.delete(it.body.collider(i).handle);
            this.world.removeRigidBody(it.body);
        }
        for (const [id, it] of this.nodes) if (gone.has(it.obj)) this.nodes.delete(id);
    }

    step(dt: number) {
        if (dt <= 0) return;
        // Characters every frame; the rest when their objects moved (by scripts; physics moving them is noticed too, and changes nothing).
        for (const it of this.chars) this.follow(it);
        for (const it of this.moves.moved) this.follow(it);
        this.moves.moved.clear();
        // Steps of 1/60 s at most: below 10 frames a second the world slows down rather than
        // take longer steps, which let bodies pass through thin ground (a terrain).
        const n = Math.min(MAX_STEPS, Math.ceil(dt * 60 - 1e-6));
        this.world.timestep = Math.min(dt / n, 1 / 60);
        const heard: [Object3D, string, Object3D][] = [];
        for (let i = 0; i < n; i++) {
            this.world.step(this.queue);
            this.queue.drainCollisionEvents((a, b, started) => {
                const A = this.owners.get(a);
                const B = this.owners.get(b);
                if (!A || !B) return;
                const sensor = this.world.getCollider(a).isSensor() || this.world.getCollider(b).isSensor();
                const method = `on${sensor ? 'Trigger' : 'Collision'}${started ? 'Enter' : 'Exit'}`;
                heard.push([A.obj, method, B.obj], [B.obj, method, A.obj]);
            });
        }
        for (const it of this.items.values()) if (it.type === 'dynamic' && !it.body.isSleeping()) this.place(it);
        // Scripts hear of it once the world is still: they may destroy objects.
        for (const [obj, method, other] of heard) this.host.notify(obj, method, other);
    }

    /** Characters and kinematic bodies go where their objects went; other bodies follow objects that scripts moved. */
    private follow(it: Item) {
        const c = it.character;
        if (c) {
            const f = c.feet;
            it.body.setNextKinematicTranslation({ x: f[0], y: f[1] + it.lift!, z: f[2] });
            for (const id of c.bumped) this.push(this.nodes.get(id), c.wanted);
            return;
        }
        const { position, rotation } = decompose(it.obj.transform.worldMatrix.rawData);
        if (!moved(it, position, rotation)) return;
        it.pos = position;
        it.rot = rotation;
        if (it.type === 'kinematic') {
            it.body.setNextKinematicTranslation(xyz(position));
            it.body.setNextKinematicRotation(xyzw(rotation));
        } else {
            it.body.setTranslation(xyz(position), true);
            it.body.setRotation(xyzw(rotation), true);
        }
    }

    /** A character walks into a dynamic body: it goes along at the character's speed (slower when heavy). */
    private push(it: Item | undefined, wanted: Vec3) {
        const speed = Math.hypot(wanted[0], wanted[2]);
        if (it?.type !== 'dynamic' || it.doc?.sensor || speed < 1e-3) return;
        const dir: Vec3 = [wanted[0] / speed, 0, wanted[2] / speed];
        const mass = it.body.mass();
        const v = it.body.linvel();
        const gain = speed * Math.min(1, PUSH_MASS / mass) - (v.x * dir[0] + v.z * dir[2]);
        if (gain > 0) it.body.applyImpulse(xyz(dir.map((x) => x * gain * mass) as Vec3), true);
    }

    /** Moves a dynamic body's object to the body. */
    private place(it: Item) {
        const t = it.body.translation();
        const r = it.body.rotation();
        it.pos = [t.x, t.y, t.z];
        it.rot = [r.x, r.y, r.z, r.w];
        const parent = it.obj.transform.parent?.object3D;
        const inv = parent && invert(parent.transform.worldMatrix.rawData);
        const local = inv ? decompose(mul(inv, compose(it.pos, it.rot, [1, 1, 1]))) : { position: it.pos, rotation: it.rot };
        [it.obj.x, it.obj.y, it.obj.z] = local.position;
        SCRATCH.set(...local.rotation);
        it.obj.transform.localRotQuat = SCRATCH;
    }

    /** The body of an object for its scripts; null without a body component. */
    api(obj: Object3D): BodyApi | null {
        const it = this.items.get(obj);
        if (!it?.doc) return null;
        const { body } = it;
        return (it.api ??= {
            type: it.type,
            get mass() {
                return body.mass();
            },
            get velocity(): Vec3 {
                const v = body.linvel();
                return [v.x, v.y, v.z];
            },
            set velocity(v: VecLike) {
                body.setLinvel(xyz(vec(v)), true);
            },
            get angularVelocity(): Vec3 {
                const v = body.angvel();
                return [v.x / DEG, v.y / DEG, v.z / DEG];
            },
            set angularVelocity(v: VecLike) {
                body.setAngvel(xyz(vec(v).map((a) => a * DEG) as Vec3), true);
            },
            applyImpulse: (v) => body.applyImpulse(xyz(vec(v)), true),
            applyTorqueImpulse: (v) => body.applyTorqueImpulse(xyz(vec(v)), true),
            teleport: (position, rotation) => {
                body.setTranslation(xyz(vec(position)), true);
                if (rotation) body.setRotation(xyzw(quatFromEuler(vec(rotation))), true);
                this.place(it);
            },
            get sleeping() {
                return body.isSleeping();
            },
            wakeUp: () => body.wakeUp(),
        });
    }

    get gravity(): Vec3 {
        const g = this.world.gravity;
        return [g.x, g.y, g.z];
    }

    set gravity(v: VecLike) {
        this.world.gravity = xyz(vec(v));
    }

    raycast(origin: VecLike, direction: VecLike, maxDistance = 1000, ignore?: Object3D): RaycastHit | null {
        const o = vec(origin);
        const d = normalize(vec(direction));
        const skip = ignore && this.items.get(ignore)?.body;
        const hit = this.world.castRayAndGetNormal(new this.R.Ray(xyz(o), xyz(d)), maxDistance, true, this.R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, skip);
        const it = hit && this.owners.get(hit.collider.handle);
        if (!hit || !it) return null;
        const t = hit.timeOfImpact;
        return { object: it.obj, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], normal: [hit.normal.x, hit.normal.y, hit.normal.z], distance: t };
    }

    dispose() {
        this.moves.clear();
        this.chars = [];
        this.queue.free();
        this.world.free();
        this.items.clear();
        this.owners.clear();
    }
}

/** A body's settings from a script's spawn options: true or a partial Body. */
export const bodyOf = (opt: boolean | Partial<BodyDoc>): BodyDoc => Body.parse(opt === true ? {} : opt);
