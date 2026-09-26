import * as core from '@orillusion/core';
import type { Camera3D, Engine3D, Object3D, Scene3D, Transform } from '@orillusion/core';
import { invert, transformPoint } from '../core/math';
import type { Vec3 } from '../core/types';
import type { Input } from './input';

// Base class of user scripts. Scripts are plain classes:
//
//     export default class Spin extends Script {
//         speed = 90;                      // public fields are editable in the Inspector
//         update(dt) { this.object3D.rotationY += this.speed * dt; }
//     }
//
// Lifecycle methods (all optional): awake, start, update(dt), lateUpdate(dt),
// onDestroy, onKeyDown(key), onKeyUp(key), onPointerDown(e), onPointerUp(e),
// onClick(e). `dt` is in seconds. Everything the runtime provides lives on
// the prototype or behind a symbol, so the enumerable own properties of an
// instance are exactly the user's fields.

export type Shape = 'box' | 'sphere' | 'plane' | 'cylinder' | 'torus' | 'ramp' | 'stairs' | 'capsule';

export interface SpawnOptions {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    /** Base color, #rrggbb. */
    color?: string;
    /** Parent object; the scene root by default. */
    parent?: Object3D;
    name?: string;
}

export interface PointerEventInfo {
    /** Pointer position in CSS pixels relative to the viewport. */
    x: number;
    y: number;
    button: number;
    /** World position of the hit on this object. */
    point: [number, number, number];
}

export interface ScriptTime {
    /** Seconds since the previous frame (capped at 0.1). */
    delta: number;
    /** Seconds since Play started. */
    elapsed: number;
    /** Frames since Play started. */
    frame: number;
}

/** What the player provides to scripts. */
export interface PlayApi {
    readonly engine: Engine3D;
    readonly scene: Scene3D;
    readonly input: Input;
    readonly time: ScriptTime;
    camera(): Camera3D;
    log(level: 'info' | 'warn' | 'error', script: Script, args: unknown[]): void;
    find(name: string): Object3D | null;
    findAll(name: string): Object3D[];
    getScript(target: Object3D | string, name?: string): Script | null;
    spawn(owner: Script, shape: Shape, opts?: SpawnOptions): Object3D;
    destroy(owner: Script, obj: Object3D, delay?: number): void;
    setColor(obj: Object3D, color: string, emissive: boolean, intensity: number): void;
    timer(owner: Script, seconds: number, fn: () => void, repeat: boolean): () => void;
    spawned(owner: Script): Object3D[];
}

/** @internal */
export interface ScriptContext {
    nodeId: string;
    nodeName: string;
    scriptName: string;
    object3D: Object3D | null;
    api: PlayApi | null;
}

export const CTX: unique symbol = Symbol('canonical.script');

let pending: ScriptContext | null = null;

/** @internal Runs `create` with `ctx` visible to the Script constructor (and so to field initializers). */
export function withContext<T>(ctx: ScriptContext, create: () => T): T {
    const prev = pending;
    pending = ctx;
    try {
        return create();
    } finally {
        pending = prev;
    }
}

function noApi(): never {
    throw new Error('This is only available in Play mode.');
}

export class Script {
    declare [CTX]: ScriptContext;

    constructor() {
        const ctx = pending ?? { nodeId: '', nodeName: '', scriptName: '', object3D: null, api: null };
        Object.defineProperty(this, CTX, { value: ctx, enumerable: false });
    }

    private get api(): PlayApi {
        return this[CTX].api ?? noApi();
    }

    /** The engine object of the node this script is attached to. */
    get object3D(): Object3D {
        return this[CTX].object3D as Object3D;
    }

    get transform(): Transform {
        return this.object3D?.transform;
    }

    /** Name of the node. */
    get name(): string {
        return this[CTX].nodeName;
    }

    /** Editor id of the node. */
    get nodeId(): string {
        return this[CTX].nodeId;
    }

    /** File name of this script. */
    get scriptName(): string {
        return this[CTX].scriptName;
    }

    get time(): ScriptTime {
        return this.api.time;
    }

    get input(): Input {
        return this.api.input;
    }

    get engine(): Engine3D {
        return this.api.engine;
    }

    /** The engine scene (Scene3D). */
    get scene(): Scene3D {
        return this.api.scene;
    }

    /** The camera Play mode renders through. */
    get camera(): Camera3D {
        return this.api.camera();
    }

    /** The whole engine API (@orillusion/core), e.g. `new this.core.Vector3(0, 1, 0)`. */
    get core(): typeof core {
        return core;
    }

    /** Objects spawned by this script that still exist. */
    get spawned(): Object3D[] {
        return this.api.spawned(this);
    }

    log(...args: unknown[]) {
        this.api.log('info', this, args);
    }

    warn(...args: unknown[]) {
        this.api.log('warn', this, args);
    }

    error(...args: unknown[]) {
        this.api.log('error', this, args);
    }

    /** First scene object with this name (document nodes first, then spawned objects). */
    find(name: string): Object3D | null {
        return this.api.find(name);
    }

    findAll(name: string): Object3D[] {
        return this.api.findAll(name);
    }

    /** A script instance on another object (or node name); `name` picks one by file or class name. */
    getScript<T extends Script = Script>(target: Object3D | string, name?: string): T | null {
        return this.api.getScript(target, name) as T | null;
    }

    /** Creates a primitive with a lit material. It is removed when Play stops. */
    spawn(shape: Shape = 'box', opts?: SpawnOptions): Object3D {
        return this.api.spawn(this, shape, opts);
    }

    /** Removes an object (this one by default), optionally after `delay` seconds. */
    destroy(obj?: Object3D, delay?: number) {
        this.api.destroy(this, obj ?? this.object3D, delay);
    }

    /** Sets the base color of the object's meshes (this object by default). */
    setColor(color: string, obj?: Object3D) {
        this.api.setColor(obj ?? this.object3D, color, false, 0);
    }

    /** Makes the object's meshes glow. */
    setEmissive(color: string, intensity = 1, obj?: Object3D) {
        this.api.setColor(obj ?? this.object3D, color, true, intensity);
    }

    /** Turns this object so its forward axis points at a position or another object. */
    lookAt(target: Object3D | [number, number, number] | { x: number; y: number; z: number }) {
        const t = this.transform;
        if (!t) return;
        let to: Vec3;
        if (Array.isArray(target)) to = [target[0], target[1], target[2]];
        else if ((target as Object3D).transform) {
            const w = (target as Object3D).transform.worldPosition;
            to = [w.x, w.y, w.z];
        } else to = [(target as any).x, (target as any).y, (target as any).z];
        // Transform.lookAt works in the parent's space.
        const parent = t.parent?.object3D;
        if (parent) {
            const inv = invert(parent.transform.worldMatrix.rawData);
            if (inv) to = transformPoint(inv, to);
        }
        const p = t.localPosition;
        t.lookAt(new core.Vector3(p.x, p.y, p.z), new core.Vector3(to[0], to[1], to[2]), core.Vector3.UP);
    }

    /** Calls `fn` once after `seconds`. Returns a function that cancels it. */
    after(seconds: number, fn: () => void): () => void {
        return this.api.timer(this, seconds, fn, false);
    }

    /** Calls `fn` every `seconds`. Returns a function that cancels it. */
    every(seconds: number, fn: () => void): () => void {
        return this.api.timer(this, seconds, fn, true);
    }
}

/** Lifecycle method names a script class may implement. */
export const LIFECYCLE = [
    'awake', 'start', 'update', 'lateUpdate', 'onDestroy', 'onKeyDown', 'onKeyUp', 'onPointerDown', 'onPointerUp', 'onClick',
] as const;
