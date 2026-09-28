import * as core from '@orillusion/core';
import type { Camera3D, Engine3D, Object3D, Scene3D, Transform } from '@orillusion/core';
import { invert, transformPoint } from '../core/math';
import type { BodyDoc, Vec3 } from '../core/types';
import type { BlackboardApi } from './ai/agents';
import type { AnimatorApi } from './animation';
import type { SayOptions } from './ai/speech';
import type { Character } from './character';
import type { Input } from './input';
import type { BodyApi, PhysicsApi } from './physics';

// Base class of user scripts. Scripts are plain classes:
//
//     export default class Spin extends Script {
//         speed = 90;                      // public fields are editable in the Inspector
//         update(dt) { this.object3D.rotationY += this.speed * dt; }
//     }
//
// Lifecycle methods (all optional): awake, start, update(dt), lateUpdate(dt),
// onDestroy, onKeyDown(key), onKeyUp(key), onPointerDown(e), onPointerUp(e),
// onClick(e), onTaskAbort(task), onCollisionEnter(other), onCollisionExit(other),
// onTriggerEnter(other), onTriggerExit(other). `dt` is in seconds. Everything the runtime provides lives on
// the prototype or behind a symbol, so the enumerable own properties of an
// instance are exactly the user's fields.

export type Shape = 'box' | 'sphere' | 'plane' | 'cylinder' | 'cone' | 'torus' | 'ramp' | 'stairs' | 'capsule';

export interface SpawnOptions {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    /** Base color, #rrggbb. */
    color?: string;
    /** Parent object; the scene root by default. */
    parent?: Object3D;
    name?: string;
    /** A physics body: true for a dynamic one, or its settings ({ type, mass, bounce, ... }). */
    body?: boolean | Partial<BodyDoc>;
}

export interface PointerEventInfo {
    /** Pointer position in CSS pixels relative to the viewport. */
    x: number;
    y: number;
    button: number;
    /** World position of the hit on this object. */
    point: [number, number, number];
}

/** A request to the language model (this.chat). */
/** A memory remembered while playing, as saveMemories() returns it (vector: int8, base64). */
export interface SavedMemory {
    id: string;
    text: string;
    tags: string[];
    vector?: string;
}

export interface ChatRequest {
    /** The user message, or the whole conversation. */
    prompt: string | { role: 'system' | 'user' | 'assistant'; content: string }[];
    system?: string;
    /** OpenRouter model id; the assistant's model by default. */
    model?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
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
    blackboard(target: Object3D | string): BlackboardApi | null;
    setPlayer(obj: Object3D | null): void;
    character(target: Object3D | string | null): Character | null;
    body(target: Object3D | string): BodyApi | null;
    physics(): PhysicsApi | null;
    animator(target: Object3D | string): AnimatorApi | null;
    remember(text: string, tags: string[]): string | null;
    memory(id: string): { id: string; text: string; tags: string[] } | null;
    saveMemories(): SavedMemory[];
    loadMemories(items: unknown): number;
    say(owner: Script, text: string, opts?: SayOptions): Promise<void>;
    chat(owner: Script, req: ChatRequest): Promise<string>;
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

    /** Turns this object so its forward axis points at a position or another object (a character turns its body). */
    lookAt(target: Object3D | [number, number, number] | { x: number; y: number; z: number }) {
        const t = this.transform;
        if (!t) return;
        let to: Vec3;
        if (Array.isArray(target)) to = [target[0], target[1], target[2]];
        else if ((target as Object3D).transform) {
            const w = (target as Object3D).transform.worldPosition;
            to = [w.x, w.y, w.z];
        } else to = [(target as any).x, (target as any).y, (target as any).z];
        const character = this.api.character(this.object3D);
        if (character?.obj === this.object3D) return character.lookAt(to);
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

    // ------------------------------------------------------------ behavior

    /**
     * The blackboard of this object's behavior tree (null when the object has
     * no agent). Read any key; write fact keys: blackboard.set('distance', 'near').
     */
    get blackboard(): BlackboardApi | null {
        return this.api.blackboard(this.object3D);
    }

    /** The blackboard of another object's behavior tree (by object or name). */
    getBlackboard(target: Object3D | string): BlackboardApi | null {
        return this.api.blackboard(target);
    }

    /**
     * This object's character (null without one): move(x, z) each frame,
     * moveTo(target, { radius, run }) (a Promise), jump(), stop(), run, face,
     * and its state (velocity, speed, grounded, mode) and events
     * (on('jump' | 'land' | 'mode', fn)) to animate it by.
     */
    get character(): Character | null {
        return this.api.character(this.object3D);
    }

    /** Another object's character (by object or name). */
    getCharacter(target: Object3D | string): Character | null {
        return this.api.character(target);
    }

    /**
     * The skeletal animation of this object's model, or of the first model
     * under it (null without clips): clips, clip (playing now), speed, and
     * play(clip, fade?) blending over `fade` seconds. A character's model
     * changes clip with the character's mode by itself.
     */
    get animator(): AnimatorApi | null {
        return this.api.animator(this.object3D);
    }

    /** Another object's animation (by object or name). */
    getAnimator(target: Object3D | string): AnimatorApi | null {
        return this.api.animator(target);
    }

    /**
     * This object's physics body (null without one): velocity and
     * angularVelocity (degrees per second) to read or set,
     * applyImpulse([x, y, z]), applyTorqueImpulse([x, y, z]),
     * teleport(position, rotation?), type, mass, sleeping and wakeUp().
     */
    get body(): BodyApi | null {
        return this.api.body(this.object3D);
    }

    /** Another object's body (by object or name). */
    getBody(target: Object3D | string): BodyApi | null {
        return this.api.body(target);
    }

    /**
     * The physics world (null when the scene has none): gravity [x, y, z]
     * and raycast(origin, direction, maxDistance?, ignoreObject?), which
     * returns { object, point, normal, distance } or null.
     */
    get physics(): PhysicsApi | null {
        return this.api.physics();
    }

    /** Agents near this object (the player) get their questions answered first. The camera counts until a script sets one. */
    setPlayer(obj: Object3D | null = this.object3D) {
        this.api.setPlayer(obj);
    }

    /** Adds a memory that Recall and Ask can find for the rest of the session (saveMemories() keeps it in a game save). Returns its id. */
    remember(text: string, tags: string[] = []): string | null {
        return this.api.remember(text, tags);
    }

    /** A memory item by id (e.g. the one an Ask picked into a key): { id, text, tags }, or null. */
    memory(id: string): { id: string; text: string; tags: string[] } | null {
        return this.api.memory(id);
    }

    /** The memories remembered while playing, as JSON to keep in a game save. */
    saveMemories(): SavedMemory[] {
        return this.api.saveMemories();
    }

    /** Puts memories from saveMemories() back (after loading a save); returns how many. */
    loadMemories(saved: unknown): number {
        return this.api.loadMemories(saved);
    }

    /** Speaks a line, one sentence at a time. Resolves when it has been spoken; a task's signal stops it. */
    say(text: string, opts?: SayOptions): Promise<void> {
        return this.api.say(this, text, opts);
    }

    /** Asks the language model (OpenRouter, in the editor) and resolves with its answer. */
    chat(prompt: ChatRequest['prompt'], opts: Omit<ChatRequest, 'prompt'> = {}): Promise<string> {
        return this.api.chat(this, { ...opts, prompt });
    }
}

/** Lifecycle method names a script class may implement. */
export const LIFECYCLE = [
    'awake', 'start', 'update', 'lateUpdate', 'onDestroy', 'onKeyDown', 'onKeyUp', 'onPointerDown', 'onPointerUp', 'onClick', 'onTaskAbort',
    'onCollisionEnter', 'onCollisionExit', 'onTriggerEnter', 'onTriggerExit',
] as const;
